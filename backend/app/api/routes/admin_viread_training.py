from __future__ import annotations

import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

from app.api.deps import get_current_parent_id, get_db
from app.schemas.viread_ocr_training import (
    BenchmarkCreate,
    DatasetImport,
    ModelDecisionRequest,
    TrainingRunComplete,
    TrainingRunCreate,
    TrainingWorkerClaim,
    TrainingWorkerFinish,
    TrainingWorkerHeartbeat,
    TrainingWorkerStatus,
)
from app.services.viread_ocr_training_service import (
    MAX_SHARD_BYTES,
    VireadOcrTrainingService,
)
from app.services.storage_service import create_signed_image_url

router = APIRouter()


def _require_training_worker_token(token: str | None = Header(default=None, alias="X-ViRead-Training-Worker")) -> None:
    expected = os.getenv("VIREAD_TRAINING_WORKER_TOKEN", "")
    if len(expected) < 32:
        raise HTTPException(status_code=503, detail="Colab worker authentication is not configured")
    if not token or not hmac.compare_digest(hashlib.sha256(token.encode()).digest(),
                                             hashlib.sha256(expected.encode()).digest()):
        raise HTTPException(status_code=401, detail="Invalid training worker credential")


def _safe_runtime(runtime: dict) -> dict[str, str | int]:
    safe: dict[str, str | int] = {}
    for key in ("device", "cuda_version", "torch_version"):
        value = runtime.get(key)
        if isinstance(value, str):
            safe[key] = value[:120]
    for key in ("vram_free_bytes", "vram_total_bytes", "ram_available_bytes", "disk_free_bytes"):
        value = runtime.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            safe[key] = value
    return safe


def _colab_worker_failure_state(job: dict, payload_run_id: UUID | None) -> tuple[str, str]:
    """Classify failures without leaving manual Colab jobs in an unpollable state."""
    tracked_execution = any((
        job.get("colab_execution_id"),
        job.get("colab_execution_resource_name"),
        job.get("colab_operation_name"),
    ))
    if tracked_execution:
        return "COLAB_EXECUTING", "COLAB_WORKER_FAILED"
    if job.get("run_id") is None and payload_run_id is None:
        return "FAILED", "COLAB_WORKER_FAILED"
    return "BLOCKED", "COLAB_FAILURE_REQUIRES_RUN_RECOVERY"


async def _leased_colab_job(service: VireadOcrTrainingService, job_id: UUID, worker_id: str):
    job = await service.repo.one("""
        SELECT id, profile, status, target, worker_id, dataset_version_id, manifest_sha256,
               config_sha256, parent_checkpoint_sha256, run_id, created_by, attempts,
               colab_execution_id, colab_execution_resource_name, colab_operation_name,
               locked_test_version_id, locked_test_manifest_sha256
        FROM public.viread_ocr_training_jobs WHERE id=:id FOR UPDATE
    """, {"id": job_id})
    if not job or job["target"] != "COLAB" or job["status"] != "COLAB_RUNNING" or job["worker_id"] != worker_id:
        await service.repo.rollback()
        raise HTTPException(status_code=409, detail="Training job lease is no longer owned by this worker")
    return job


@router.get("/admin/viread-training/overview")
async def get_viread_training_overview(
    actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db),
):
    return await VireadOcrTrainingService(db).overview(actor_id)


@router.post("/admin/viread-training/jobs/{job_id}/retry")
async def retry_failed_viread_colab_training_job(
    job_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Retry a pre-run failure or resume a verified candidate at Locked Test."""
    await VireadOcrTrainingService(db)._admin(actor_id)
    result = await db.execute(text("""
        SELECT id, target, status, attempts, run_id, profile, dataset_version_id,
               manifest_sha256, config_sha256, created_by,
               parent_checkpoint_sha256, colab_execution_id,
               colab_execution_resource_name, colab_operation_name, last_error_code
        FROM public.viread_ocr_training_jobs
        WHERE id=:job_id
        FOR UPDATE
    """), {"job_id": job_id})
    row = result.mappings().first()
    if not row:
        await db.rollback()
        raise HTTPException(status_code=404, detail="Training job was not found")
    if (row["target"] != "COLAB" or int(row["attempts"]) >= 3
            or row["colab_execution_id"] is not None
            or row["colab_execution_resource_name"] is not None
            or row["colab_operation_name"] is not None):
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="This Colab job has no safe retry available",
        )

    retry_candidate_for_benchmark = (
        row["status"] == "BLOCKED"
        and row["run_id"] is not None
        and row["last_error_code"] in {"HTTPERROR", "COLAB_FAILURE_REQUIRES_RUN_RECOVERY"}
    )
    retry_before_run = row["status"] == "FAILED" and row["run_id"] is None
    if not retry_before_run and not retry_candidate_for_benchmark:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Only a pre-run failure or an unbenchmarked candidate with a recoverable Colab error can be retried",
        )

    if retry_candidate_for_benchmark:
        run_result = await db.execute(text("""
            SELECT id, status, profile, dataset_version_id, manifest_sha256,
                   config_sha256, parent_checkpoint_sha256, created_by,
                   checkpoint_sha256, checkpoint_bytes, checkpoint_storage_path
            FROM public.viread_ocr_training_runs WHERE id=:run_id FOR UPDATE
        """), {"run_id": row["run_id"]})
        run = run_result.mappings().first()
        checkpoint_sha = run["checkpoint_sha256"] if run else None
        valid_checkpoint_sha = (
            isinstance(checkpoint_sha, str)
            and len(checkpoint_sha) == 64
            and all(character in "0123456789abcdef" for character in checkpoint_sha)
        )
        if (not run or run["status"] != "CANDIDATE" or not valid_checkpoint_sha
                or int(run["checkpoint_bytes"] or 0) <= 0 or not run["checkpoint_storage_path"]
                or run["profile"] != row["profile"]
                or str(run["dataset_version_id"]) != str(row["dataset_version_id"])
                or run["manifest_sha256"] != row["manifest_sha256"]
                or run["config_sha256"] != row["config_sha256"]
                or run["parent_checkpoint_sha256"] != row["parent_checkpoint_sha256"]
                or str(run["created_by"]) != str(row["created_by"])):
            await db.rollback()
            raise HTTPException(
                status_code=409,
                detail="The registered candidate is incomplete or its lineage does not match this job",
            )
        benchmark = await db.execute(text("""
            SELECT id FROM public.viread_ocr_benchmarks WHERE run_id=:run_id LIMIT 1
        """), {"run_id": row["run_id"]})
        if benchmark.scalar_one_or_none() is not None:
            await db.rollback()
            raise HTTPException(status_code=409, detail="This candidate already has a benchmark result")

    active = await db.execute(text("""
        SELECT checkpoint_sha256 FROM public.viread_ocr_active_model
        WHERE singleton=TRUE FOR SHARE
    """))
    if active.scalar_one_or_none() != row["parent_checkpoint_sha256"]:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="The active model changed; create a fresh job from the current model lineage",
        )

    unresolved = await db.execute(text("""
        SELECT id FROM public.viread_ocr_training_jobs
        WHERE id<>:job_id
          AND status IN ('QUEUED', 'LOCAL_RUNNING', 'FALLBACK_QUEUED_COLAB', 'COLAB_RUNNING',
                         'WAITING_FOR_DATA', 'WAITING_FOR_COLAB_WORKER', 'COLAB_SUBMITTING',
                         'COLAB_SUBMITTED', 'COLAB_EXECUTING', 'BLOCKED_CONFIGURATION',
                         'BLOCKED', 'CANDIDATE', 'BENCHMARKED')
        ORDER BY created_at DESC LIMIT 1
    """), {"job_id": job_id})
    if unresolved.scalar_one_or_none() is not None:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Another training job still needs attention")

    await db.execute(text("""
        UPDATE public.viread_ocr_training_jobs
        SET status='WAITING_FOR_COLAB_WORKER', target='COLAB', worker_id=NULL,
            lease_expires_at=NULL, available_at=now(),
            progress=CAST(:progress AS jsonb),
            last_error_code=NULL,
            metadata=COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'retry_requested_by', CAST(:actor_id AS text),
                'retry_requested_at', now(),
                'retry_previous_error', :previous_error,
                'retry_mode', :retry_mode
            ),
            updated_at=now()
        WHERE id=:job_id
    """), {
        "job_id": job_id,
        "actor_id": str(actor_id),
        "previous_error": row["last_error_code"],
        "retry_mode": "candidate_benchmark_recovery" if retry_candidate_for_benchmark else "pre_run_retry",
        "progress": json.dumps({
            "stage": "waiting_for_colab_worker",
            "retry_requested": True,
            "recovery_mode": "candidate_benchmark" if retry_candidate_for_benchmark else "pre_run",
        }),
    })
    await db.commit()
    return {"job_id": job_id, "status": "WAITING_FOR_COLAB_WORKER",
            "recovery_mode": "candidate_benchmark" if retry_candidate_for_benchmark else "pre_run"}


@router.get("/admin/viread-training/datasets/flow1")
@router.get("/admin/viread-training/datasets/flow2-admin-verified")
async def get_admin_verified_training_manifest(
    limit: int = 200,
    offset: int = 0,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    if not 1 <= limit <= 200 or offset < 0:
        raise HTTPException(status_code=422, detail="limit must be 1-200 and offset must be non-negative")
    return await VireadOcrTrainingService(db).admin_verified_manifest(actor_id, limit=limit, offset=offset)


@router.get("/admin/viread-training/active-model/artifact")
async def get_viread_active_model_artifact(
    actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db),
):
    return await VireadOcrTrainingService(db).active_model_artifact(actor_id)


@router.get("/admin/viread-training/datasets/{dataset_version_id}/samples")
async def get_viread_training_dataset_samples(
    dataset_version_id: UUID,
    limit: int = 200,
    offset: int = 0,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    if not 1 <= limit <= 200 or offset < 0:
        raise HTTPException(status_code=422, detail="limit must be 1-200 and offset must be non-negative")
    return await VireadOcrTrainingService(db).dataset_samples(actor_id, dataset_version_id, limit=limit, offset=offset)


@router.post("/admin/viread-training/datasets/objects", status_code=status.HTTP_201_CREATED)
async def upload_viread_training_dataset_object(
    source_flow: str = Form(...),
    file: UploadFile = File(...),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    data = await file.read(MAX_SHARD_BYTES + 1)
    return await VireadOcrTrainingService(db).upload_dataset_object(
        actor_id, source_flow, file.filename or "image", data, file.content_type or "application/octet-stream"
    )


@router.post("/admin/viread-training/datasets", status_code=status.HTTP_201_CREATED)
async def register_viread_training_dataset(
    payload: DatasetImport,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await VireadOcrTrainingService(db).register_dataset(actor_id, payload)


@router.post("/admin/viread-training/runs", status_code=status.HTTP_201_CREATED)
async def create_viread_training_run(
    payload: TrainingRunCreate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await VireadOcrTrainingService(db).create_run(actor_id, payload)


@router.post("/admin/viread-training/runs/{run_id}/chunks", status_code=status.HTTP_201_CREATED)
async def upload_viread_checkpoint_chunk(
    run_id: UUID,
    chunk_index: int = Form(ge=0),
    file: UploadFile = File(...),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    data = await file.read(MAX_SHARD_BYTES + 1)
    if len(data) > MAX_SHARD_BYTES:
        raise HTTPException(status_code=413, detail="Checkpoint shard exceeds 40 MiB")
    return await VireadOcrTrainingService(db).upload_checkpoint_chunk(actor_id, run_id, chunk_index, data)


@router.post("/admin/viread-training/runs/{run_id}/complete")
async def complete_viread_training_run(
    run_id: UUID,
    payload: TrainingRunComplete,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await VireadOcrTrainingService(db).complete_run(actor_id, run_id, payload)


@router.post("/admin/viread-training/benchmarks", status_code=status.HTTP_201_CREATED)
async def register_viread_locked_benchmark(
    payload: BenchmarkCreate,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await VireadOcrTrainingService(db).benchmark(actor_id, payload)


@router.post("/admin/viread-training/decisions")
async def decide_viread_model(
    payload: ModelDecisionRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await VireadOcrTrainingService(db).decide(actor_id, payload)


@router.post("/admin/viread-training/worker/claim")
async def claim_viread_colab_training_job(
    payload: TrainingWorkerClaim,
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    runtime = _safe_runtime(payload.runtime)
    result = await db.execute(text("""
        WITH next_job AS (
            SELECT id FROM public.viread_ocr_training_jobs
            WHERE target='COLAB' AND available_at <= now() AND attempts < 3 AND (
                (CAST(:requested_job_id AS uuid) IS NULL AND status IN ('WAITING_FOR_COLAB_WORKER', 'FALLBACK_QUEUED_COLAB'))
                OR (CAST(:requested_job_id AS uuid) IS NOT NULL AND id=CAST(:requested_job_id AS uuid)
                    AND status IN ('COLAB_SUBMITTING', 'COLAB_SUBMITTED', 'COLAB_EXECUTING'))
                OR (status='COLAB_RUNNING' AND lease_expires_at < now()
                    AND (CAST(:requested_job_id AS uuid) IS NULL OR id=CAST(:requested_job_id AS uuid)))
            )
            ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE public.viread_ocr_training_jobs AS job
        SET status='COLAB_RUNNING', worker_id=:worker_id,
            lease_expires_at=now() + interval '15 minutes', attempts=job.attempts+1,
            progress=CAST(:progress AS jsonb),
            metadata=job.metadata || CAST(:metadata AS jsonb), updated_at=now()
        FROM next_job WHERE job.id=next_job.id
        RETURNING job.id, job.profile, job.dataset_version_id, job.manifest_sha256,
                  job.config_sha256, job.parent_checkpoint_sha256, job.created_by,
                  job.attempts, job.run_id, job.metadata,
                  job.locked_test_version_id, job.locked_test_manifest_sha256
    """), {"worker_id": payload.worker_id, "requested_job_id": payload.training_job_id,
          "progress": json.dumps({"stage": "claimed", "runtime": runtime}),
          "metadata": json.dumps({"colab_worker_id": payload.worker_id,
                                   "colab_worker_status": {"status": "READY", "runtime": runtime}})})
    job = result.mappings().first()
    if not job:
        await db.commit()
        return {"job": None}
    locked = await db.execute(text("""
        SELECT id, version_sha256 FROM public.viread_ocr_dataset_versions
        WHERE source_flow='LOCKED_TEST' AND is_locked_test=TRUE
          AND (CAST(:locked_id AS uuid) IS NULL OR id=CAST(:locked_id AS uuid))
        ORDER BY created_at DESC LIMIT 1
    """), {"locked_id": job["locked_test_version_id"]})
    locked_row = locked.mappings().first()
    dataset = await db.execute(text("""
        SELECT source_flow, version_sha256, sample_count, is_locked_test, manifest_storage_path
        FROM public.viread_ocr_dataset_versions WHERE id=:id
    """), {"id": job["dataset_version_id"]})
    dataset_row = dataset.mappings().first()
    if not dataset_row or dataset_row["version_sha256"] != job["manifest_sha256"] or dataset_row["is_locked_test"]:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Training dataset is missing or its registered hash changed")
    service = VireadOcrTrainingService(db)
    if not job["created_by"]:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Training job no longer has an Admin owner")
    await service._admin(UUID(str(job["created_by"])))
    manifest_url = create_signed_image_url(dataset_row["manifest_storage_path"])
    if locked_row:
        if job["locked_test_manifest_sha256"] and job["locked_test_manifest_sha256"] != locked_row["version_sha256"]:
            await db.rollback()
            raise HTTPException(status_code=409, detail="Job Locked Test manifest changed")
        await db.execute(text("""
            UPDATE public.viread_ocr_training_jobs SET locked_test_version_id=:test_id,
                locked_test_manifest_sha256=:test_sha WHERE id=:job_id
        """), {"test_id": locked_row["id"], "test_sha": locked_row["version_sha256"],
              "job_id": job["id"]})
    active = await service.active_model_artifact(UUID(str(job["created_by"])))
    if active["checkpoint_sha256"] != job["parent_checkpoint_sha256"]:
        await db.execute(text("""
            UPDATE public.viread_ocr_training_jobs SET status='BLOCKED', worker_id=NULL,
                lease_expires_at=NULL, last_error_code='ACTIVE_PARENT_CHANGED', updated_at=now()
            WHERE id=:id
        """), {"id": job["id"]})
        await db.commit()
        raise HTTPException(status_code=409, detail="Training parent checkpoint is no longer active; job must be requeued")
    await db.commit()
    return {"job": {**dict(job),
                     "dataset": {**dict(dataset_row), "manifest_url": manifest_url},
                     "active_model": active,
                     "locked_test_version_id": locked_row["id"] if locked_row else None,
                     "locked_test_manifest_sha256": locked_row["version_sha256"] if locked_row else None}}


@router.post("/admin/viread-training/worker/status")
async def report_viread_colab_worker_status(
    payload: TrainingWorkerStatus,
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    runtime = _safe_runtime(payload.runtime)
    status_data = {"worker_id": payload.worker_id, "status": payload.status,
                   "reason_code": payload.reason_code, "runtime": runtime,
                   "reported_at": datetime.now(timezone.utc).isoformat()}
    await db.execute(text("""
        UPDATE public.viread_ocr_training_jobs
        SET metadata=metadata || CAST(:metadata AS jsonb), updated_at=now()
        WHERE target='COLAB' AND status IN ('WAITING_FOR_COLAB_WORKER','FALLBACK_QUEUED_COLAB')
    """), {"metadata": json.dumps({"colab_worker_status": status_data})})
    await db.commit()
    return {"status": payload.status}


@router.get("/admin/viread-training/worker/jobs/{job_id}/dataset")
async def get_viread_colab_job_dataset(
    job_id: UUID,
    worker_id: str,
    limit: int = 200,
    offset: int = 0,
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    if not 1 <= limit <= 200 or offset < 0:
        raise HTTPException(status_code=422, detail="limit must be 1-200 and offset must be non-negative")
    service = VireadOcrTrainingService(db)
    job = await _leased_colab_job(service, job_id, worker_id)
    await service._admin(UUID(str(job["created_by"])))
    result = await service.dataset_samples(UUID(str(job["created_by"])), job["dataset_version_id"],
                                           limit=limit, offset=offset)
    if result["dataset"]["version_sha256"] != job["manifest_sha256"]:
        raise HTTPException(status_code=409, detail="Job dataset hash does not match the claimed manifest")
    await db.commit()
    return result


@router.get("/admin/viread-training/worker/jobs/{job_id}/locked-test")
async def get_viread_colab_job_locked_test(
    job_id: UUID,
    worker_id: str,
    limit: int = 200,
    offset: int = 0,
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    if not 1 <= limit <= 200 or offset < 0:
        raise HTTPException(status_code=422, detail="limit must be 1-200 and offset must be non-negative")
    service = VireadOcrTrainingService(db)
    job = await _leased_colab_job(service, job_id, worker_id)
    await service._admin(UUID(str(job["created_by"])))
    locked = await service.repo.one("""
        SELECT id, source_flow, version_sha256, sample_count, is_locked_test, manifest_storage_path
        FROM public.viread_ocr_dataset_versions
        WHERE id=COALESCE(:locked_id, (SELECT id FROM public.viread_ocr_dataset_versions
                  WHERE source_flow='LOCKED_TEST' AND is_locked_test=TRUE
                  ORDER BY created_at DESC LIMIT 1))
          AND source_flow='LOCKED_TEST' AND is_locked_test=TRUE
    """, {"locked_id": job["locked_test_version_id"]})
    if not locked:
        await db.commit()
        return {"dataset": None, "items": [], "next_offset": None}
    if job["locked_test_manifest_sha256"] and job["locked_test_manifest_sha256"] != locked["version_sha256"]:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Job Locked Test manifest changed")
    if not job["locked_test_version_id"]:
        await db.execute(text("""
            UPDATE public.viread_ocr_training_jobs SET locked_test_version_id=:test_id,
                locked_test_manifest_sha256=:test_sha WHERE id=:job_id
        """), {"test_id": locked["id"], "test_sha": locked["version_sha256"], "job_id": job_id})
    result = await service.dataset_samples(UUID(str(job["created_by"])), locked["id"],
                                           limit=limit, offset=offset)
    await db.commit()
    return result


@router.post("/admin/viread-training/worker/jobs/{job_id}/runs")
async def create_viread_colab_job_run(
    job_id: UUID,
    worker_id: str,
    payload: TrainingRunCreate,
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    service = VireadOcrTrainingService(db)
    job = await _leased_colab_job(service, job_id, worker_id)
    await service._admin(UUID(str(job["created_by"])))
    if (payload.profile != job["profile"] or payload.dataset_version_id != job["dataset_version_id"]
            or payload.manifest_sha256 != job["manifest_sha256"]
            or payload.parent_checkpoint_sha256 != job["parent_checkpoint_sha256"]):
        await db.rollback()
        raise HTTPException(status_code=422, detail="Run lineage does not match its claimed Flow 2 job")
    if job["run_id"]:
        run = await service.repo.one("""
            SELECT id AS run_id, status, profile, parent_checkpoint_sha256,
                   manifest_sha256, config_sha256, architecture_sha256, vocabulary_sha256,
                   checkpoint_sha256
            FROM public.viread_ocr_training_runs WHERE id=:id
        """, {"id": job["run_id"]})
        if not run or any(run[key] != getattr(payload, key) for key in (
            "profile", "parent_checkpoint_sha256", "manifest_sha256", "config_sha256",
            "architecture_sha256", "vocabulary_sha256")):
            await db.rollback()
            raise HTTPException(status_code=409, detail="Existing job run has different training lineage")
        await db.commit()
        return run
    created = await service.create_run(UUID(str(job["created_by"])), payload)
    await db.execute(text("""
        UPDATE public.viread_ocr_training_jobs SET run_id=:run_id,
            progress='{"stage":"candidate_upload"}'::jsonb, updated_at=now()
        WHERE id=:job_id AND worker_id=:worker_id AND status='COLAB_RUNNING'
    """), {"run_id": created["run_id"], "job_id": job_id, "worker_id": worker_id})
    await db.commit()
    return created


@router.get("/admin/viread-training/worker/jobs/{job_id}/runs/{run_id}/result")
async def get_viread_colab_job_run_result(
    job_id: UUID,
    run_id: UUID,
    worker_id: str,
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    service = VireadOcrTrainingService(db)
    job = await _leased_colab_job(service, job_id, worker_id)
    if str(job["run_id"]) != str(run_id):
        await db.rollback()
        raise HTTPException(status_code=409, detail="Run is not attached to this training job")
    run = await service.repo.one("""
        SELECT id, status, profile FROM public.viread_ocr_training_runs WHERE id=:run_id
    """, {"run_id": run_id})
    if not run or run["profile"] != job["profile"]:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Training run profile differs from its job")
    if run["status"] == "BENCHMARKED":
        benchmark = await service.repo.one("""
            SELECT gate_status FROM public.viread_ocr_benchmarks
            WHERE run_id=:run_id ORDER BY created_at DESC LIMIT 1
        """, {"run_id": run_id})
        if not benchmark:
            await db.rollback()
            raise HTTPException(status_code=409, detail="Benchmark result is missing")
        status_value = "BENCHMARKED" if benchmark["gate_status"] == "V2_WIN" else "QUALITY_GATE_REJECTED"
        await db.commit()
        return {"run_id": run_id, "run_status": run["status"],
                "gate_status": benchmark["gate_status"], "job_status": status_value}
    await db.commit()
    return {"run_id": run_id, "run_status": run["status"], "gate_status": None,
            "job_status": "CANDIDATE" if run["status"] == "CANDIDATE" else run["status"]}


@router.post("/admin/viread-training/worker/jobs/{job_id}/runs/{run_id}/chunks")
async def upload_viread_colab_job_chunk(
    job_id: UUID,
    run_id: UUID,
    worker_id: str = Form(...),
    chunk_index: int = Form(ge=0),
    file: UploadFile = File(...),
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    service = VireadOcrTrainingService(db)
    job = await _leased_colab_job(service, job_id, worker_id)
    if str(job["run_id"]) != str(run_id):
        await db.rollback()
        raise HTTPException(status_code=409, detail="Checkpoint upload run is not attached to this job")
    actor_id = UUID(str(job["created_by"]))
    await service._admin(actor_id)
    data = await file.read(MAX_SHARD_BYTES + 1)
    if len(data) > MAX_SHARD_BYTES:
        raise HTTPException(status_code=413, detail="Checkpoint shard exceeds 40 MiB")
    result = await service.upload_checkpoint_chunk(actor_id, run_id, chunk_index, data)
    return result


@router.post("/admin/viread-training/worker/jobs/{job_id}/runs/{run_id}/complete")
async def complete_viread_colab_job_run(
    job_id: UUID,
    run_id: UUID,
    worker_id: str,
    payload: TrainingRunComplete,
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    service = VireadOcrTrainingService(db)
    job = await _leased_colab_job(service, job_id, worker_id)
    if str(job["run_id"]) != str(run_id) or payload.profile != job["profile"]:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Completed run is not attached to this job")
    actor_id = UUID(str(job["created_by"]))
    await service._admin(actor_id)
    # The lease row was selected FOR UPDATE above. Release it before checkpoint
    # verification, which performs multiple Storage downloads, then revalidate
    # ownership under a short lock when the candidate is committed.
    await db.commit()
    return await service.complete_run(actor_id, run_id, payload, job_id=job_id, worker_id=worker_id)


@router.post("/admin/viread-training/worker/jobs/{job_id}/benchmarks")
async def benchmark_viread_colab_job(
    job_id: UUID,
    worker_id: str,
    payload: BenchmarkCreate,
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    service = VireadOcrTrainingService(db)
    job = await _leased_colab_job(service, job_id, worker_id)
    if (str(payload.run_id) != str(job["run_id"]) or
            str(payload.locked_test_version_id) != str(job["locked_test_version_id"]) or
            payload.locked_test_manifest_sha256 != job["locked_test_manifest_sha256"]):
        await db.rollback()
        raise HTTPException(status_code=422, detail="Benchmark dataset or run differs from the immutable job selection")
    result = await service.benchmark(UUID(str(job["created_by"])), payload)
    await db.execute(text("""
        UPDATE public.viread_ocr_training_jobs SET progress=CAST(:progress AS jsonb),
            updated_at=now() WHERE id=:id
    """), {"id": job_id, "progress": json.dumps({"stage": "benchmarked", "gate_status": result["gate_status"]})})
    await db.commit()
    return result


@router.post("/admin/viread-training/worker/jobs/{job_id}/heartbeat")
async def heartbeat_viread_colab_training_job(
    job_id: UUID,
    payload: TrainingWorkerHeartbeat,
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    runtime = _safe_runtime(payload.runtime)
    result = await db.execute(text("""
        UPDATE public.viread_ocr_training_jobs SET
            lease_expires_at=now() + interval '15 minutes',
            progress=CAST(:progress AS jsonb), updated_at=now()
        WHERE id=:id AND target='COLAB' AND status='COLAB_RUNNING' AND worker_id=:worker_id
        RETURNING id
    """), {"id": job_id, "worker_id": payload.worker_id,
          "progress": json.dumps({"stage": payload.stage,
              "completed_steps": payload.completed_steps, "total_steps": payload.total_steps,
              "runtime": runtime})})
    if not result.scalar_one_or_none():
        await db.rollback()
        raise HTTPException(status_code=409, detail="Training job lease is no longer owned by this worker")
    await db.commit()
    return {"job_id": job_id, "status": "COLAB_RUNNING"}


@router.post("/admin/viread-training/worker/jobs/{job_id}/finish")
async def finish_viread_colab_training_job(
    job_id: UUID,
    payload: TrainingWorkerFinish,
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    service = VireadOcrTrainingService(db)
    job = await _leased_colab_job(service, job_id, payload.worker_id)
    if payload.status in {"CANDIDATE", "BENCHMARKED", "QUALITY_GATE_REJECTED"}:
        run = await service.repo.one("""
            SELECT id, status, profile, dataset_version_id, manifest_sha256,
                   parent_checkpoint_sha256, created_by
            FROM public.viread_ocr_training_runs WHERE id=:id
        """, {"id": payload.run_id}) if payload.run_id else None
        expected_status = "CANDIDATE" if payload.status == "CANDIDATE" else "BENCHMARKED"
        if (not run or run["status"] != expected_status or run["profile"] != job["profile"]
                or run["dataset_version_id"] != job["dataset_version_id"]
                or run["manifest_sha256"] != job["manifest_sha256"]
                or run["parent_checkpoint_sha256"] != job["parent_checkpoint_sha256"]
                or str(run["created_by"]) != str(job["created_by"])
                or str(payload.run_id) != str(job["run_id"])):
            await db.rollback()
            raise HTTPException(status_code=422, detail="Worker result does not match the registered training job")
        if payload.status in {"BENCHMARKED", "QUALITY_GATE_REJECTED"}:
            benchmark = await service.repo.one("""
                SELECT gate_status FROM public.viread_ocr_benchmarks
                WHERE run_id=:run_id ORDER BY created_at DESC LIMIT 1
            """, {"run_id": payload.run_id})
            expected_gate = "V2_WIN" if payload.status == "BENCHMARKED" else None
            if not benchmark or (expected_gate and benchmark["gate_status"] != expected_gate) or (
                payload.status == "QUALITY_GATE_REJECTED" and benchmark["gate_status"] == "V2_WIN"
            ):
                await db.rollback()
                raise HTTPException(status_code=422, detail="Training result does not match its registered quality gate")
    new_status = payload.status
    retry_delay = 0
    error_code = payload.error_code
    if payload.status == "FAILED":
        # Enterprise execution is polled through Google; manual/free Colab has no
        # execution identity and must not remain in COLAB_EXECUTING forever.
        new_status, default_error_code = _colab_worker_failure_state(job, payload.run_id)
        error_code = payload.error_code or default_error_code
    runtime = _safe_runtime(payload.runtime)
    await service.repo.execute("""
        UPDATE public.viread_ocr_training_jobs SET status=:status, run_id=:run_id,
            last_error_code=:error_code, lease_expires_at=NULL, worker_id=NULL,
            available_at=now() + (:retry_delay * interval '1 second'),
            progress=CAST(:progress AS jsonb),
            metadata=metadata || CAST(:metadata AS jsonb), updated_at=now()
        WHERE id=:id
    """, {"id": job_id, "status": new_status, "run_id": payload.run_id or job["run_id"],
          "error_code": error_code, "retry_delay": retry_delay,
          "progress": json.dumps({"stage": new_status.lower()}),
          "metadata": json.dumps({"runtime": runtime})})
    if payload.run_id and runtime:
        await service.repo.execute("""
            UPDATE public.viread_ocr_training_runs SET metadata=metadata || CAST(:metadata AS jsonb)
            WHERE id=:run_id
        """, {"run_id": payload.run_id, "metadata": json.dumps({
            "execution_target": "COLAB", "training_job_id": str(job_id),
            "worker_id": payload.worker_id, "runtime": runtime,
        })})
    await service.repo.commit()
    return {"job_id": job_id, "status": new_status, "run_id": payload.run_id or job["run_id"]}
