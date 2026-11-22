from __future__ import annotations

import asyncio
import hashlib
import hmac
import inspect
import json
import os
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

from app.api.deps import get_current_parent_id, get_db
from app.schemas.viread_ocr_training import (
    BenchmarkCreate,
    CandidateEvaluationRequest,
    DatasetImport,
    GoogleDriveConnectAppsScriptRequest,
    GoogleDriveConnectCallbackRequest,
    GoogleDriveConnectDesktopRequest,
    GoogleDriveConnectStartRequest,
    ModelDecisionRequest,
    TrainingRunComplete,
    TrainingRunCreate,
    TrainingWorkerClaim,
    TrainingWorkerFinish,
    TrainingWorkerHeartbeat,
    TrainingWorkerStatus,
)
from app.services.training_storage import (
    TrainingStorageError,
    is_gdrive_ref,
    sign_worker_artifact_token,
    verify_worker_artifact_token,
)
from app.services.viread_drive_connection_service import VireadDriveConnectionService
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
               locked_test_version_id, locked_test_manifest_sha256, metadata,
               (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_active
        FROM public.viread_ocr_training_jobs WHERE id=:id FOR UPDATE
    """, {"id": job_id})
    if (
        not job
        or job["target"] != "COLAB"
        or job["status"] != "COLAB_RUNNING"
        or job["worker_id"] != worker_id
        or not job.get("lease_active", True)
    ):
        await service.repo.rollback()
        raise HTTPException(status_code=409, detail="Training job lease is no longer owned by this worker")
    return job


@router.get("/admin/viread-training/overview")
async def get_viread_training_overview(
    actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db),
):
    return await VireadOcrTrainingService(db).overview(actor_id)


@router.get("/admin/viread-training/drive/status")
async def get_viread_training_drive_status(
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    await VireadOcrTrainingService(db)._admin(actor_id)
    return await VireadDriveConnectionService(db).get_status()


@router.post("/admin/viread-training/drive/connect/start")
async def start_viread_training_drive_connect(
    payload: GoogleDriveConnectStartRequest | None = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    await VireadOcrTrainingService(db)._admin(actor_id)
    return await VireadDriveConnectionService(db).start_connect(
        actor_id=actor_id,
        redirect_uri=payload.redirect_uri if payload else None,
    )


@router.post("/admin/viread-training/drive/connect/callback")
async def complete_viread_training_drive_connect(
    payload: GoogleDriveConnectCallbackRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    await VireadOcrTrainingService(db)._admin(actor_id)
    return await VireadDriveConnectionService(db).complete_callback(
        actor_id=actor_id,
        code=payload.code,
        state=payload.state,
    )


@router.post("/admin/viread-training/drive/connect/apps-script")
async def connect_viread_training_drive_apps_script(
    payload: GoogleDriveConnectAppsScriptRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    await VireadOcrTrainingService(db)._admin(actor_id)
    return await VireadDriveConnectionService(db).connect_apps_script(
        actor_id=actor_id,
        web_app_url=payload.web_app_url,
        bridge_secret=payload.bridge_secret,
    )


@router.post("/admin/viread-training/drive/connect/desktop")
async def connect_viread_training_drive_desktop(
    payload: GoogleDriveConnectDesktopRequest | None = None,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    await VireadOcrTrainingService(db)._admin(actor_id)
    return await VireadDriveConnectionService(db).connect_drive_desktop(
        actor_id=actor_id,
        sync_root_path=payload.sync_root_path if payload else None,
        account_email=payload.account_email if payload else None,
    )


@router.post("/admin/viread-training/drive/health-check")
async def check_viread_training_drive_health(
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    await VireadOcrTrainingService(db)._admin(actor_id)
    return await VireadDriveConnectionService(db).check_health()


@router.post("/admin/viread-training/drive/self-test")
async def run_viread_training_drive_self_test(
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    await VireadOcrTrainingService(db)._admin(actor_id)
    return await VireadDriveConnectionService(db).run_self_test()


@router.post("/admin/viread-training/drive/disconnect")
async def disconnect_viread_training_drive(
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    await VireadOcrTrainingService(db)._admin(actor_id)
    return await VireadDriveConnectionService(db).disconnect()


@router.delete("/admin/viread-training/jobs/{job_id}")
async def delete_viread_training_job(
    job_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Delete a terminal queue entry while retaining its dataset and run artifacts."""
    service = VireadOcrTrainingService(db)
    await service._admin(actor_id)
    result = await db.execute(text("""
        DELETE FROM public.viread_ocr_training_jobs
        WHERE id=:job_id
          AND status NOT IN (
            'QUEUED', 'LOCAL_RUNNING', 'FALLBACK_QUEUED_COLAB',
            'COLAB_RUNNING', 'WAITING_FOR_DATA', 'WAITING_FOR_COLAB_WORKER',
            'COLAB_SUBMITTING', 'COLAB_SUBMITTED', 'COLAB_EXECUTING'
          )
        RETURNING id
    """), {"job_id": job_id})
    deleted_id = result.scalar_one_or_none()
    if deleted_id is None:
        exists = await db.execute(text(
            "SELECT status FROM public.viread_ocr_training_jobs WHERE id=:job_id"
        ), {"job_id": job_id})
        current_status = exists.scalar_one_or_none()
        await db.rollback()
        if current_status is None:
            raise HTTPException(status_code=404, detail="Training job was not found")
        raise HTTPException(status_code=409, detail="A queued or running training job cannot be deleted")
    await db.commit()
    return {"job_id": deleted_id, "deleted": True}


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
               parent_checkpoint_sha256, locked_test_version_id,
               locked_test_manifest_sha256, colab_execution_id,
               colab_execution_resource_name, colab_operation_name, last_error_code
        FROM public.viread_ocr_training_jobs
        WHERE id=:job_id
        FOR UPDATE
    """), {"job_id": job_id})
    row = result.mappings().first()
    if not row:
        await db.rollback()
        raise HTTPException(status_code=404, detail="Training job was not found")
    has_locked_test = bool(row["locked_test_version_id"] and row["locked_test_manifest_sha256"])
    if bool(row["locked_test_version_id"]) != bool(row["locked_test_manifest_sha256"]):
        await db.rollback()
        raise HTTPException(status_code=409, detail="The pinned Locked Test lineage is incomplete")
    if (row["target"] != "COLAB" or int(row["attempts"]) >= 3
            or row["colab_execution_id"] is not None
            or row["colab_execution_resource_name"] is not None
            or row["colab_operation_name"] is not None):
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="This Colab job has no safe retry available",
        )

    if has_locked_test:
        locked_test = await db.execute(text("""
        SELECT locked.id
        FROM public.viread_ocr_dataset_versions locked
        WHERE locked.id=CAST(:locked_test_id AS uuid)
          AND locked.version_sha256=:locked_test_sha
          AND locked.source_flow='LOCKED_TEST' AND locked.is_locked_test=TRUE
          AND locked.sample_count >= 200
          AND (SELECT count(*) FROM public.viread_ocr_samples sample
               WHERE sample.dataset_version_id=locked.id
                 AND sample.source_flow='LOCKED_TEST' AND sample.split='locked_test')=locked.sample_count
          AND (SELECT count(DISTINCT sample.source_group_id)
               FROM public.viread_ocr_samples sample
               WHERE sample.dataset_version_id=locked.id
                 AND sample.source_flow='LOCKED_TEST' AND sample.split='locked_test') >= 30
        """), {"locked_test_id": row["locked_test_version_id"],
              "locked_test_sha": row["locked_test_manifest_sha256"]})
        if locked_test.scalar_one_or_none() is None:
            await db.rollback()
            raise HTTPException(status_code=409, detail="The pinned Locked Test is missing or no longer meets its integrity requirements")

    retry_candidate_for_benchmark = (
        row["status"] == "BLOCKED"
        and has_locked_test
        and row["run_id"] is not None
        and row["last_error_code"] in {"HTTPERROR", "COLAB_FAILURE_REQUIRES_RUN_RECOVERY"}
    )
    retry_before_run = row["status"] == "FAILED" and row["run_id"] is None
    retry_partial_upload = (
        row["status"] == "BLOCKED" and row["run_id"] is not None
        and row["last_error_code"] == "COLAB_RETRY_REQUIRES_RUN_RECOVERY"
        and not has_locked_test
    )
    if retry_partial_upload:
        partial_run_result = await db.execute(text("""
            SELECT id, status, profile, dataset_version_id, manifest_sha256,
                   config_sha256, parent_checkpoint_sha256, created_by
            FROM public.viread_ocr_training_runs WHERE id=:run_id FOR UPDATE
        """), {"run_id": row["run_id"]})
        partial_run = partial_run_result.mappings().first()
        if (not partial_run or partial_run["status"] != "TRAINING"
                or partial_run["profile"] != row["profile"]
                or str(partial_run["dataset_version_id"]) != str(row["dataset_version_id"])
                or partial_run["manifest_sha256"] != row["manifest_sha256"]
                or partial_run["config_sha256"] != row["config_sha256"]
                or partial_run["parent_checkpoint_sha256"] != row["parent_checkpoint_sha256"]
                or str(partial_run["created_by"]) != str(row["created_by"])):
            await db.rollback()
            raise HTTPException(status_code=409, detail="The partial checkpoint upload run is missing or has different lineage")
    if not retry_before_run and not retry_candidate_for_benchmark and not retry_partial_upload:
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
                'retry_previous_error', CAST(:previous_error AS text),
                'retry_mode', CAST(:retry_mode AS text)
            ),
            updated_at=now()
        WHERE id=:job_id
    """), {
        "job_id": job_id,
        "actor_id": str(actor_id),
        "previous_error": row["last_error_code"],
        "retry_mode": ("candidate_benchmark_recovery" if retry_candidate_for_benchmark else
                       "partial_checkpoint_upload" if retry_partial_upload else "pre_run_retry"),
        "progress": json.dumps({
            "stage": "waiting_for_colab_worker",
            "retry_requested": True,
            "recovery_mode": ("candidate_benchmark" if retry_candidate_for_benchmark else
                              "partial_checkpoint_upload" if retry_partial_upload else "pre_run"),
        }),
    })
    await db.commit()
    return {"job_id": job_id, "status": "WAITING_FOR_COLAB_WORKER",
            "recovery_mode": ("candidate_benchmark" if retry_candidate_for_benchmark else
                              "partial_checkpoint_upload" if retry_partial_upload else "pre_run")}


@router.post("/admin/viread-training/jobs/{job_id}/discard-mismatched-candidate")
async def discard_mismatched_viread_colab_candidate(
    job_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Close only a blocked candidate whose registered config fingerprint differs from its job.

    The immutable checkpoint and run are retained for audit. The candidate remains unbenchmarked
    and cannot be promoted; closing the queue row lets the scheduler create a correctly locked job.
    """
    await VireadOcrTrainingService(db)._admin(actor_id)
    job_result = await db.execute(text("""
        SELECT id, target, status, run_id, profile, dataset_version_id,
               manifest_sha256, config_sha256, parent_checkpoint_sha256, created_by,
               last_error_code, colab_execution_id, colab_execution_resource_name,
               colab_operation_name
        FROM public.viread_ocr_training_jobs
        WHERE id=:job_id FOR UPDATE
    """), {"job_id": job_id})
    job_row = job_result.mappings().first()
    if not job_row:
        await db.rollback()
        raise HTTPException(status_code=404, detail="Training job was not found")
    row = dict(job_row)
    run_result = await db.execute(text("""
        SELECT status AS run_status, profile AS run_profile,
               dataset_version_id AS run_dataset_version_id,
               manifest_sha256 AS run_manifest_sha256, config_sha256 AS run_config_sha256,
               parent_checkpoint_sha256 AS run_parent_checkpoint_sha256,
               created_by AS run_created_by, checkpoint_sha256, checkpoint_bytes,
               checkpoint_storage_path
        FROM public.viread_ocr_training_runs
        WHERE id=:run_id FOR UPDATE
    """), {"run_id": row["run_id"]}) if row["run_id"] else None
    run_row = run_result.mappings().first() if run_result else None
    row.update(dict(run_row or {}))
    recoverable_error = row["last_error_code"] in {
        "HTTPERROR", "COLAB_FAILURE_REQUIRES_RUN_RECOVERY",
    }
    def valid_sha256(value):
        return (
            isinstance(value, str)
            and len(value) == 64
            and all(character in "0123456789abcdef" for character in value)
        )

    valid_checkpoint_sha = (
        valid_sha256(row.get("checkpoint_sha256"))
    )
    if (row["target"] != "COLAB" or row["status"] != "BLOCKED"
            or not recoverable_error or row["run_id"] is None or not run_row
            or any((row["colab_execution_id"], row["colab_execution_resource_name"],
                    row["colab_operation_name"]))
            or row["run_status"] != "CANDIDATE"
            or row["run_profile"] != row["profile"]
            or str(row["run_dataset_version_id"]) != str(row["dataset_version_id"])
            or row["run_manifest_sha256"] != row["manifest_sha256"]
            or row["run_parent_checkpoint_sha256"] != row["parent_checkpoint_sha256"]
            or str(row["run_created_by"]) != str(row["created_by"])
            or not valid_sha256(row["config_sha256"])
            or not valid_sha256(row["run_config_sha256"])
            or row["run_config_sha256"] == row["config_sha256"]
            or not valid_checkpoint_sha or int(row["checkpoint_bytes"] or 0) <= 0
            or not row["checkpoint_storage_path"]):
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Only a retained, unbenchmarked candidate with matching non-config lineage and a mismatched config fingerprint can be closed",
        )
    benchmark = await db.execute(text(
        "SELECT id FROM public.viread_ocr_benchmarks WHERE run_id=:run_id LIMIT 1"
    ), {"run_id": row["run_id"]})
    if benchmark.scalar_one_or_none() is not None:
        await db.rollback()
        raise HTTPException(status_code=409, detail="A benchmarked candidate cannot be closed by this recovery action")
    active = await db.execute(text("""
        SELECT checkpoint_sha256 FROM public.viread_ocr_active_model
        WHERE singleton=TRUE FOR SHARE
    """))
    if active.scalar_one_or_none() != row["parent_checkpoint_sha256"]:
        await db.rollback()
        raise HTTPException(status_code=409, detail="The active model changed; preserve this job for review")
    await db.execute(text("""
        UPDATE public.viread_ocr_training_jobs
        SET status='FAILED', worker_id=NULL, lease_expires_at=NULL,
            last_error_code='CANDIDATE_CONFIG_LINEAGE_MISMATCH_DISCARDED',
            progress=COALESCE(progress, '{}'::jsonb) || jsonb_build_object(
                'stage', 'candidate_closed_config_mismatch'
            ),
            metadata=COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'candidate_disposition', 'closed_config_lineage_mismatch',
                'candidate_disposition_by', CAST(:actor_id AS text),
                'candidate_disposition_at', now(),
                'candidate_disposition_note', 'Run and checkpoint retained; candidate was not benchmarked or promoted.'
            ),
            updated_at=now()
        WHERE id=:job_id AND status='BLOCKED'
    """), {"job_id": job_id, "actor_id": str(actor_id)})
    await db.commit()
    return {"job_id": job_id, "status": "FAILED",
            "run_id": str(row["run_id"]), "checkpoint_retained": True,
            "candidate_promoted": False}


@router.post("/admin/viread-training/jobs/{job_id}/close-unbenchmarked-candidate")
async def close_unbenchmarked_viread_candidate(
    job_id: UUID,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Stop a finished, unbenchmarked candidate while preserving its audit artifacts."""
    await VireadOcrTrainingService(db)._admin(actor_id)
    # Keep lock order consistent with model decisions and prevent the active
    # lineage from changing while this candidate is being closed.
    active = await db.execute(text("""
        SELECT checkpoint_sha256 FROM public.viread_ocr_active_model
        WHERE singleton=TRUE FOR SHARE
    """))
    active_checkpoint_sha256 = active.scalar_one_or_none()
    job_result = await db.execute(text("""
        SELECT id, target, status, worker_id, lease_expires_at, run_id,
               profile, dataset_version_id, manifest_sha256, config_sha256,
               parent_checkpoint_sha256, locked_test_version_id,
               locked_test_manifest_sha256, created_by,
               colab_execution_id, colab_execution_resource_name, colab_operation_name
        FROM public.viread_ocr_training_jobs
        WHERE id=:job_id FOR UPDATE
    """), {"job_id": job_id})
    job_row = job_result.mappings().first()
    if not job_row:
        await db.rollback()
        raise HTTPException(status_code=404, detail="Training job was not found")
    job = dict(job_row)
    # CANDIDATE is a terminal training state. Historical Colab execution IDs
    # are retained for audit and do not mean that a worker is still running.
    # BLOCKED is deliberately excluded because it can represent live work.
    if (job["status"] != "CANDIDATE" or job["worker_id"] is not None
            or job["lease_expires_at"] is not None and job["lease_expires_at"] > datetime.now(timezone.utc)
            or job["run_id"] is None):
        await db.rollback()
        raise HTTPException(status_code=409, detail="Only a finished candidate with no active worker lease can be closed")

    run_result = await db.execute(text("""
        SELECT id, status, profile, dataset_version_id, manifest_sha256,
               config_sha256, parent_checkpoint_sha256, created_by,
               checkpoint_sha256, checkpoint_bytes, checkpoint_storage_path
        FROM public.viread_ocr_training_runs WHERE id=:run_id FOR UPDATE
    """), {"run_id": job["run_id"]})
    run_row = run_result.mappings().first()
    run = dict(run_row or {})

    def valid_sha256(value: object) -> bool:
        return (isinstance(value, str) and len(value) == 64
                and all(character in "0123456789abcdef" for character in value))

    if (not run or run["status"] != "CANDIDATE"
            or run["profile"] != job["profile"]
            or str(run["dataset_version_id"]) != str(job["dataset_version_id"])
            or run["manifest_sha256"] != job["manifest_sha256"]
            or run["config_sha256"] != job["config_sha256"]
            or run["parent_checkpoint_sha256"] != job["parent_checkpoint_sha256"]
            or str(run["created_by"]) != str(job["created_by"])
            or not valid_sha256(run.get("checkpoint_sha256"))
            or int(run.get("checkpoint_bytes") or 0) <= 0
            or not run.get("checkpoint_storage_path")):
        await db.rollback()
        raise HTTPException(status_code=409, detail="Candidate checkpoint or training lineage is incomplete")
    benchmark = await db.execute(text(
        "SELECT id FROM public.viread_ocr_benchmarks WHERE run_id=:run_id LIMIT 1"
    ), {"run_id": job["run_id"]})
    if benchmark.scalar_one_or_none() is not None:
        await db.rollback()
        raise HTTPException(status_code=409, detail="A benchmarked candidate cannot be closed as unbenchmarked")
    if active_checkpoint_sha256 != job["parent_checkpoint_sha256"]:
        await db.rollback()
        raise HTTPException(status_code=409, detail="The active model changed; preserve this candidate for review")

    await db.execute(text("""
        UPDATE public.viread_ocr_training_jobs
        SET status='FAILED', worker_id=NULL, lease_expires_at=NULL,
            last_error_code='CANDIDATE_CLOSED_UNBENCHMARKED',
            progress=COALESCE(progress, '{}'::jsonb) || jsonb_build_object(
                'stage', 'candidate_closed_unbenchmarked'
            ),
            metadata=COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'candidate_disposition', 'closed_unbenchmarked_candidate',
                'candidate_disposition_by', CAST(:actor_id AS text),
                'candidate_disposition_at', now(),
                'candidate_disposition_note', 'Run and checkpoint retained; candidate was not benchmarked or promoted.'
            ),
            updated_at=now()
            WHERE id=:job_id AND status='CANDIDATE'
    """), {"job_id": job_id, "actor_id": str(actor_id)})
    await db.commit()
    return {"job_id": str(job_id), "status": "FAILED", "run_id": str(job["run_id"]),
            "checkpoint_retained": True, "candidate_promoted": False}


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


@router.post("/admin/viread-training/flow1-model/chunks", status_code=status.HTTP_201_CREATED)
async def upload_viread_flow1_model_chunk(
    upload_id: UUID = Form(...),
    chunk_index: int = Form(ge=0),
    file: UploadFile = File(...),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    data = await file.read(MAX_SHARD_BYTES + 1)
    if len(data) > MAX_SHARD_BYTES:
        raise HTTPException(status_code=413, detail="Checkpoint shard exceeds 40 MiB")
    return await VireadOcrTrainingService(db).upload_flow1_model_chunk(
        actor_id, upload_id, chunk_index, data
    )


@router.post("/admin/viread-training/flow1-model/activate")
async def activate_viread_flow1_model(
    upload_id: UUID = Form(...),
    weights_filename: str = Form(...),
    chunks_json: str = Form(...),
    comparison_file: UploadFile = File(...),
    config_file: UploadFile | None = File(None),
    model_version: str | None = Form(None),
    reason: str | None = Form(None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    comparison_bytes = await comparison_file.read(2 * 1024 * 1024 + 1)
    if len(comparison_bytes) > 2 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Comparison file exceeds 2 MiB")
    config_bytes = None
    config_filename = None
    if config_file is not None and config_file.filename:
        config_bytes = await config_file.read(1024 * 1024 + 1)
        if len(config_bytes) > 1024 * 1024:
            raise HTTPException(status_code=413, detail="Configuration file exceeds 1 MiB")
        config_filename = config_file.filename

    return await VireadOcrTrainingService(db).activate_flow1_model(
        actor_id=actor_id,
        upload_id=upload_id,
        weights_filename=weights_filename,
        chunks_json=chunks_json,
        comparison_bytes=comparison_bytes,
        config_bytes=config_bytes,
        config_filename=config_filename,
        model_version=model_version,
        reason=reason,
    )


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


@router.post("/admin/viread-training/jobs/{job_id}/evaluate")
async def request_viread_candidate_evaluation(
    job_id: UUID,
    payload: CandidateEvaluationRequest,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    return await VireadOcrTrainingService(db).request_candidate_evaluation(
        actor_id, job_id, payload.evaluation_type
    )


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
            WHERE target='COLAB' AND available_at <= now() AND (
                (metadata->>'operation'='BENCHMARK_ONLY' AND evaluation_attempts < 3)
                OR (COALESCE(metadata->>'operation','TRAIN') <> 'BENCHMARK_ONLY' AND attempts < 3)
            ) AND (
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
            lease_expires_at=now() + interval '15 minutes',
            attempts=CASE WHEN job.metadata->>'operation'='BENCHMARK_ONLY' THEN job.attempts ELSE job.attempts+1 END,
            evaluation_attempts=CASE WHEN job.metadata->>'operation'='BENCHMARK_ONLY'
                                     THEN job.evaluation_attempts+1 ELSE job.evaluation_attempts END,
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
    locked_row = None
    if job["locked_test_version_id"] and job["locked_test_manifest_sha256"]:
        locked = await db.execute(text("""
            SELECT id, version_sha256 FROM public.viread_ocr_dataset_versions
            WHERE source_flow='LOCKED_TEST' AND is_locked_test=TRUE
              AND id=CAST(:locked_id AS uuid) AND version_sha256=:locked_sha
        """), {"locked_id": job["locked_test_version_id"],
              "locked_sha": job["locked_test_manifest_sha256"]})
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
    if is_gdrive_ref(dataset_row["manifest_storage_path"]):
        manifest_token = sign_worker_artifact_token(
            job_id=str(job["id"]),
            worker_id=payload.worker_id,
            reference=dataset_row["manifest_storage_path"],
            expected_sha256=dataset_row["version_sha256"],
        )
        manifest_url = (
            f"/books/admin/viread-training/worker/jobs/{job['id']}/artifact-stream"
            f"?worker_id={payload.worker_id}&token={manifest_token}"
        )
    else:
        manifest_url = create_signed_image_url(dataset_row["manifest_storage_path"])
    if (job["locked_test_version_id"] or job["locked_test_manifest_sha256"]) and not locked_row:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Pinned evaluation dataset is missing or its hash changed")
    if "job_id" in inspect.signature(service.active_model_artifact).parameters:
        active = await service.active_model_artifact(
            UUID(str(job["created_by"])),
            job_id=job["id"],
            worker_id=payload.worker_id,
        )
    else:
        active = await service.active_model_artifact(UUID(str(job["created_by"])))
    metadata = job.get("metadata") or {}
    benchmark_only_pilot = (metadata.get("operation") == "BENCHMARK_ONLY"
                            and metadata.get("evaluation_type") == "PILOT")
    if not benchmark_only_pilot and active["checkpoint_sha256"] != job["parent_checkpoint_sha256"]:
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
    if "job_id" in inspect.signature(service.dataset_samples).parameters:
        result = await service.dataset_samples(
            UUID(str(job["created_by"])),
            job["dataset_version_id"],
            limit=limit,
            offset=offset,
            job_id=job_id,
            worker_id=worker_id,
        )
    else:
        result = await service.dataset_samples(
            UUID(str(job["created_by"])),
            job["dataset_version_id"],
            limit=limit,
            offset=offset,
        )
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
    if not job["locked_test_version_id"] or not job["locked_test_manifest_sha256"]:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Training job was created without a pinned Locked Test")
    locked = await service.repo.one("""
        SELECT id, source_flow, version_sha256, sample_count, is_locked_test, manifest_storage_path
        FROM public.viread_ocr_dataset_versions
        WHERE id=CAST(:locked_id AS uuid) AND version_sha256=:locked_sha
          AND source_flow='LOCKED_TEST' AND is_locked_test=TRUE
    """, {"locked_id": job["locked_test_version_id"],
          "locked_sha": job["locked_test_manifest_sha256"]})
    if not locked:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Pinned Locked Test is missing or its manifest hash changed")
    if "job_id" in inspect.signature(service.dataset_samples).parameters:
        result = await service.dataset_samples(
            UUID(str(job["created_by"])),
            locked["id"],
            limit=limit,
            offset=offset,
            job_id=job_id,
            worker_id=worker_id,
        )
    else:
        result = await service.dataset_samples(
            UUID(str(job["created_by"])),
            locked["id"],
            limit=limit,
            offset=offset,
        )
    await db.commit()
    return result


@router.get("/admin/viread-training/worker/jobs/{job_id}/artifact-stream")
async def stream_viread_colab_job_artifact(
    job_id: UUID,
    worker_id: str,
    token: str,
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    """Stream one DB-authorized private Google Drive artifact to the actively leased worker.

    Enforces four independent controls:
    1. Valid X-ViRead-Training-Worker credential.
    2. Server-only HMAC token bound to (job_id, worker_id, gdrive:// ref, sha256, exp).
    3. Active COLAB_RUNNING lease owned by worker_id.
    4. Server-side DB authorization proving claims.reference belongs to this job's
       dataset, pinned Locked Test, active parent model, or attached candidate run.
    """
    try:
        claims = verify_worker_artifact_token(
            token,
            expected_job_id=str(job_id),
            expected_worker_id=worker_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    if not is_gdrive_ref(claims.reference):
        raise HTTPException(
            status_code=403,
            detail="Worker artifact stream only serves private Google Drive references",
        )

    service = VireadOcrTrainingService(db)
    job = await service.repo.one("""
        SELECT id, target, status, worker_id, lease_expires_at,
               dataset_version_id, locked_test_version_id,
               parent_checkpoint_sha256, run_id
        FROM public.viread_ocr_training_jobs
        WHERE id = :id
    """, {"id": job_id})
    if (
        not job
        or job["target"] != "COLAB"
        or job["status"] != "COLAB_RUNNING"
        or job["worker_id"] != worker_id
        or job["lease_expires_at"] is None
        or job["lease_expires_at"] <= datetime.now(timezone.utc)
    ):
        await db.rollback()
        raise HTTPException(status_code=409, detail="Training job lease is no longer active for artifact streaming")

    authorized = await service.repo.one("""
        SELECT (
            EXISTS (
                SELECT 1 FROM public.viread_ocr_dataset_versions dv
                WHERE dv.id IN (CAST(:dataset_id AS uuid), CAST(:locked_id AS uuid))
                  AND dv.manifest_storage_path = :ref
            )
            OR EXISTS (
                SELECT 1 FROM public.viread_ocr_samples s
                WHERE s.dataset_version_id IN (CAST(:dataset_id AS uuid), CAST(:locked_id AS uuid))
                  AND s.image_storage_path = :ref
            )
            OR EXISTS (
                SELECT 1 FROM public.viread_ocr_checkpoint_chunks c
                WHERE c.run_id = CAST(:run_id AS uuid)
                  AND c.storage_path = :ref
            )
            OR EXISTS (
                SELECT 1 FROM public.viread_ocr_training_runs r
                WHERE r.id = CAST(:run_id AS uuid)
                  AND r.checkpoint_storage_path = :ref
            )
            OR EXISTS (
                SELECT 1 FROM public.viread_ocr_active_model am
                WHERE am.singleton = TRUE
                  AND am.checkpoint_sha256 = :parent_sha
                  AND am.storage_path = :ref
            )
            OR EXISTS (
                SELECT 1 FROM public.viread_ocr_checkpoint_chunks pc
                JOIN public.viread_ocr_training_runs pr ON pr.id = pc.run_id
                WHERE pr.checkpoint_sha256 = :parent_sha
                  AND pc.storage_path = :ref
            )
        ) AS is_authorized
    """, {
        "dataset_id": job["dataset_version_id"],
        "locked_id": job["locked_test_version_id"],
        "run_id": job["run_id"],
        "parent_sha": job["parent_checkpoint_sha256"],
        "ref": claims.reference,
    })
    if not authorized or not authorized.get("is_authorized"):
        await db.rollback()
        raise HTTPException(
            status_code=403,
            detail="Requested artifact is not authorized for this leased training job",
        )

    router_store = await VireadDriveConnectionService(db).build_artifact_router()
    # Release DB transaction before streaming potentially large files over HTTP.
    await db.commit()
    try:
        meta = await asyncio.to_thread(router_store.get_metadata, claims.reference)
    except TrainingStorageError as exc:
        raise HTTPException(status_code=exc.http_status or 503, detail=f"{exc.code}: {exc}") from exc
    if meta.trashed:
        raise HTTPException(status_code=404, detail="Requested training artifact is unavailable")

    def _chunk_iterator():
        yield from router_store.open_stream(
            claims.reference,
            expected_sha256=claims.expected_sha256,
            preloaded_meta=meta,
        )

    return StreamingResponse(
        _chunk_iterator(),
        media_type=meta.content_type or "application/octet-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


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


@router.get("/admin/viread-training/worker/jobs/{job_id}/runs/{run_id}/artifact")
async def get_viread_colab_candidate_artifact(
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
        raise HTTPException(status_code=409, detail="Candidate run is not attached to this evaluation job")
    if "job_id" in inspect.signature(service.candidate_artifact).parameters:
        artifact = await service.candidate_artifact(
            UUID(str(job["created_by"])),
            run_id,
            job_id=job_id,
            worker_id=worker_id,
        )
    else:
        artifact = await service.candidate_artifact(UUID(str(job["created_by"])), run_id)
    await db.commit()
    return artifact


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
            metadata=metadata || CAST(:metadata AS jsonb), updated_at=now()
        WHERE id=:id AND target='COLAB' AND status='COLAB_RUNNING' AND worker_id=:worker_id
    """), {"id": job_id, "worker_id": worker_id,
          "progress": json.dumps({"stage": "benchmarked", "gate_status": result["gate_status"]}),
          "metadata": json.dumps({"evaluation_status": "COMPLETED",
                                  "evaluation_gate_status": result["gate_status"],
                                  "evaluation_type": result["evaluation_type"]})})
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
          AND lease_expires_at IS NOT NULL AND lease_expires_at > now()
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
        if (job.get("metadata") or {}).get("operation") == "BENCHMARK_ONLY":
            # Evaluation failures leave the immutable candidate available for retry.
            new_status = "CANDIDATE"
    runtime = _safe_runtime(payload.runtime)
    await service.repo.execute("""
        UPDATE public.viread_ocr_training_jobs SET status=:status, run_id=:run_id,
            last_error_code=:error_code, lease_expires_at=NULL, worker_id=NULL,
            available_at=now() + (:retry_delay * interval '1 second'),
            progress=CAST(:progress AS jsonb),
            metadata=metadata || CAST(:metadata AS jsonb), updated_at=now()
        WHERE id=:id AND target='COLAB' AND status='COLAB_RUNNING' AND worker_id=:worker_id
    """, {"id": job_id, "worker_id": payload.worker_id, "status": new_status, "run_id": payload.run_id or job["run_id"],
          "error_code": error_code, "retry_delay": retry_delay,
          "progress": json.dumps({"stage": new_status.lower()}),
          "metadata": json.dumps({"runtime": runtime,
                                  **({"evaluation_status": "FAILED"} if payload.status == "FAILED"
                                     and (job.get("metadata") or {}).get("operation") == "BENCHMARK_ONLY" else {})})})
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


@router.get("/admin/viread-training/worker/jobs/{job_id}/resume-state")
async def list_viread_colab_resume_state(
    job_id: UUID,
    worker_id: str,
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    """List job-scoped resume objects stored in the server's connected owner Google Drive."""
    service = VireadOcrTrainingService(db)
    await _leased_colab_job(service, job_id, worker_id)
    await db.commit()
    return await VireadDriveConnectionService(db).list_job_resume_files(job_id)


@router.get("/admin/viread-training/worker/jobs/{job_id}/resume-state/{object_path:path}")
async def download_viread_colab_resume_object(
    job_id: UUID,
    object_path: str,
    worker_id: str,
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    """Stream a resume file from the owner's Google Drive to any authorized Colab worker account."""
    service = VireadOcrTrainingService(db)
    await _leased_colab_job(service, job_id, worker_id)
    await db.commit()
    meta, stream = await VireadDriveConnectionService(db).open_job_resume_stream(job_id, object_path)
    headers = {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
    }
    if meta.sha256:
        headers["X-ViRead-SHA256"] = meta.sha256
    if meta.size_bytes is not None:
        headers["Content-Length"] = str(meta.size_bytes)
    return StreamingResponse(
        stream,
        media_type=meta.content_type or "application/octet-stream",
        headers=headers,
    )


@router.put("/admin/viread-training/worker/jobs/{job_id}/resume-state/{object_path:path}")
async def upload_viread_colab_resume_object(
    job_id: UUID,
    object_path: str,
    worker_id: str = Form(...),
    expected_sha256: str | None = Form(default=None),
    file: UploadFile = File(...),
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    """Upload a resume snapshot object strictly into the owner's Google Drive (no Colab Drive mount)."""
    service = VireadOcrTrainingService(db)
    await _leased_colab_job(service, job_id, worker_id)
    await db.commit()
    data = await file.read(MAX_SHARD_BYTES + 1)
    if len(data) > MAX_SHARD_BYTES:
        raise HTTPException(status_code=413, detail="Resume state object exceeds 40 MiB chunk limit")
    return await VireadDriveConnectionService(db).put_job_resume_file(
        job_id,
        object_path,
        data,
        expected_sha256=(expected_sha256 or "").strip().lower() or None,
    )


@router.delete("/admin/viread-training/worker/jobs/{job_id}/resume-state/{object_path:path}")
async def delete_viread_colab_resume_object(
    job_id: UUID,
    object_path: str,
    worker_id: str,
    _worker: None = Depends(_require_training_worker_token),
    db: AsyncSession = Depends(get_db),
):
    """Prune an obsolete resume object from the owner's Google Drive after manifest commit."""
    service = VireadOcrTrainingService(db)
    await _leased_colab_job(service, job_id, worker_id)
    await db.commit()
    return await VireadDriveConnectionService(db).delete_job_resume_file(job_id, object_path)
