from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import text

from app.database.session import AsyncSessionLocal
from app.diagnostic_logging import log_diagnostic
from app.services.storage_service import download_object
from app.services.viread_ocr_training_service import (
    MAX_SHARD_BYTES,
    ORIGINAL_ARCHITECTURE_SHA256,
    ORIGINAL_SHA256,
    ORIGINAL_VOCAB_SHA256,
    VireadOcrTrainingService,
)

logger = logging.getLogger(__name__)
POLL_SECONDS = 20
LEASE_SECONDS = 900
MAX_ATTEMPTS = 3


def _work_root() -> Path:
    configured = os.getenv("VIETOCR_TRAINING_WORK_DIR", "").strip()
    return Path(configured) if configured else Path(tempfile.gettempdir())


def _available_ram_bytes() -> int:
    if os.name == "nt":
        import ctypes

        class MemoryStatusEx(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

        memory = MemoryStatusEx()
        memory.dwLength = ctypes.sizeof(memory)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory)):
            raise OSError("GlobalMemoryStatusEx failed")
        return int(memory.ullAvailPhys)
    available = int(os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE"))
    for maximum_path, current_path in (
        (Path("/sys/fs/cgroup/memory.max"), Path("/sys/fs/cgroup/memory.current")),
        (Path("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
         Path("/sys/fs/cgroup/memory/memory.usage_in_bytes")),
    ):
        try:
            maximum = maximum_path.read_text(encoding="ascii").strip()
            if maximum.isdigit():
                current = int(current_path.read_text(encoding="ascii").strip())
                available = min(available, max(0, int(maximum) - current))
                break
        except (OSError, ValueError):
            continue
    return available


def local_training_capacity() -> tuple[bool, dict[str, Any]]:
    """Require a real CUDA runtime and configurable free VRAM/disk before claiming local work."""
    local_enabled = os.getenv("VIREAD_LOCAL_TRAINING_ENABLED", "true").strip().lower() in {
        "1", "true", "yes", "on",
    }
    if not local_enabled:
        return False, {"reason": "LOCAL_TRAINING_DISABLED"}
    minimum_vram = int(os.getenv("VIETOCR_TRAINING_MIN_VRAM_MIB", "6144"))
    minimum_ram = int(os.getenv("VIETOCR_TRAINING_MIN_RAM_GB", "8")) * 1024**3
    minimum_disk = int(os.getenv("VIETOCR_TRAINING_MIN_DISK_GB", "8")) * 1024**3
    details: dict[str, Any] = {"minimum_vram_mib": minimum_vram,
                               "minimum_ram_bytes": minimum_ram,
                               "minimum_disk_bytes": minimum_disk}
    try:
        import torch

        if not torch.cuda.is_available():
            return False, {**details, "reason": "CUDA_UNAVAILABLE", "torch_version": torch.__version__}
        free_bytes, total_bytes = torch.cuda.mem_get_info(0)
        if not getattr(torch.version, "cuda", None):
            return False, {**details, "reason": "PYTORCH_CPU_BUILD", "torch_version": torch.__version__}
        details.update({"device": torch.cuda.get_device_name(0),
                        "cuda_version": torch.version.cuda,
                        "device_capability": list(torch.cuda.get_device_capability(0)),
                        "vram_free_bytes": int(free_bytes),
                        "vram_total_bytes": int(total_bytes), "torch_version": torch.__version__})
        if free_bytes < minimum_vram * 1024**2:
            return False, {**details, "reason": "INSUFFICIENT_VRAM"}
    except Exception as exc:
        return False, {**details, "reason": "CUDA_PROBE_FAILED", "error_type": type(exc).__name__}
    try:
        available_ram = _available_ram_bytes()
        details["ram_available_bytes"] = available_ram
        if available_ram < minimum_ram:
            return False, {**details, "reason": "INSUFFICIENT_RAM"}
    except Exception as exc:
        return False, {**details, "reason": "RAM_PROBE_FAILED", "error_type": type(exc).__name__}
    work_root = _work_root()
    try:
        work_root.mkdir(parents=True, exist_ok=True)
        free_disk = shutil.disk_usage(work_root).free
        details["disk_free_bytes"] = free_disk
        if free_disk < minimum_disk:
            return False, {**details, "reason": "INSUFFICIENT_DISK"}
    except OSError as exc:
        return False, {**details, "reason": "WORK_DIRECTORY_UNAVAILABLE", "error_type": type(exc).__name__}
    return True, {**details, "reason": "LOCAL_GPU_READY"}


async def _has_unresolved_training_job(db) -> bool:
    result = await db.execute(text("""
        SELECT EXISTS (
            SELECT 1 FROM public.viread_ocr_training_jobs
            WHERE status IN (
                'QUEUED', 'LOCAL_RUNNING', 'FALLBACK_QUEUED_COLAB', 'COLAB_RUNNING',
                'WAITING_FOR_COLAB_WORKER', 'COLAB_SUBMITTING', 'COLAB_SUBMITTED',
                'COLAB_EXECUTING', 'BLOCKED_CONFIGURATION', 'BLOCKED', 'CANDIDATE', 'BENCHMARKED'
            )
        )
    """))
    return bool(result.scalar_one())


def _training_config(profile: str, repo_root: Path) -> tuple[dict[str, Any], str]:
    config = {
        "profile": profile,
        "steps": int(os.getenv("VIETOCR_TRAINING_STEPS", "5000")),
        "batch_size": int(os.getenv("VIETOCR_TRAINING_BATCH_SIZE", "8")),
        "freeze_epochs": int(os.getenv("VIETOCR_TRAINING_FREEZE_EPOCHS", "5")),
        "seed": int(os.getenv("VIETOCR_TRAINING_SEED", "20261113")),
        "fp16": True, "scheduler": "CosineAnnealingLR", "optimizer": "AdamW",
        "preprocessing": "opencv-line-v1",
        "architecture_sha256": ORIGINAL_ARCHITECTURE_SHA256,
        "vocabulary_sha256": ORIGINAL_VOCAB_SHA256,
    }
    config["trainer_sha256"] = hashlib.sha256(
        (repo_root / "ai" / "vietocr_v2" / "train.py").read_bytes()
    ).hexdigest()
    config["requirements_sha256"] = hashlib.sha256(
        (repo_root / "ai" / "vietocr_v2" / "requirements.txt").read_bytes()
    ).hexdigest()
    config["colab_requirements_sha256"] = hashlib.sha256(
        (repo_root / "ai" / "vietocr_v2" / "requirements-colab.txt").read_bytes()
    ).hexdigest()
    config_sha = hashlib.sha256(json.dumps(
        config, sort_keys=True, separators=(",", ":")
    ).encode()).hexdigest()
    return config, config_sha


async def _set_job(job_id: UUID, *, status: str, target: str | None = None,
                   run_id: UUID | None = None, error_code: str | None = None,
                   metadata: dict[str, Any] | None = None, retry_delay: int = 0) -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(text("""
            UPDATE public.viread_ocr_training_jobs
            SET status=:status, target=COALESCE(:target, target), run_id=COALESCE(:run_id, run_id),
                last_error_code=:error_code, lease_expires_at=NULL, worker_id=NULL,
                available_at=now() + (:retry_delay * interval '1 second'),
                metadata=metadata || CAST(:metadata AS jsonb), updated_at=now()
            WHERE id=:id
        """), {"id": job_id, "status": status, "target": target, "run_id": run_id,
              "error_code": error_code, "retry_delay": retry_delay,
              "metadata": json.dumps(metadata or {})})
        await db.commit()


def flow1_dataset_readiness(counts: dict[str, int]) -> tuple[bool, str | None]:
    """Apply the existing Flow 1 real/TRDG limits without lowering them to make a dataset ready."""
    limits = {"FLOW2_EXTERNAL": (500, 1_000), "FLOW2_TRDG": (20_000, 50_000)}
    for flow, (minimum, maximum) in limits.items():
        count = int(counts.get(flow, 0))
        if count < minimum:
            return False, f"{flow}_BELOW_MINIMUM"
        if count > maximum:
            return False, f"{flow}_ABOVE_MAXIMUM"
        if not int(counts.get(f"{flow}_train", 0)) or not int(counts.get(f"{flow}_validation", 0)):
            return False, f"{flow}_TRAIN_AND_VALIDATION_REQUIRED"
    return True, None


def colab_failure_action(execution_number: int, run_id: Any) -> tuple[str, str | None]:
    """Retry failed executions only before they create partial registered run state."""
    if run_id is not None:
        return "BLOCKED", "COLAB_RETRY_REQUIRES_RUN_RECOVERY"
    if execution_number >= MAX_ATTEMPTS:
        return "FAILED", "COLAB_EXECUTION_RETRY_LIMIT"
    return "WAITING_FOR_COLAB_WORKER", "COLAB_EXECUTION_FAILED"


def dataset_snapshot_count_matches(declared_count: int, materialized_count: int | None) -> bool:
    """Refuse to launch a paid worker when DB rows disagree with the immutable receipt count."""
    return materialized_count is not None and declared_count >= 0 and declared_count == materialized_count


async def _schedule_ready_flow1() -> int:
    """Enqueue an immutable Flow 1 job only when the registered real+TRDG version meets its contract."""
    async with AsyncSessionLocal() as db:
        if await _has_unresolved_training_job(db):
            return 0
        result = await db.execute(text("""
            SELECT version.id AS dataset_version_id, version.version_sha256,
                   version.created_by, version.created_at,
                   count(*) FILTER (WHERE sample.source_flow='FLOW2_EXTERNAL')::integer AS external_count,
                   count(*) FILTER (WHERE sample.source_flow='FLOW2_TRDG')::integer AS trdg_count,
                   count(*) FILTER (WHERE sample.source_flow='FLOW2_EXTERNAL' AND sample.split='train')::integer AS external_train,
                   count(*) FILTER (WHERE sample.source_flow='FLOW2_EXTERNAL' AND sample.split='validation')::integer AS external_validation,
                   count(*) FILTER (WHERE sample.source_flow='FLOW2_TRDG' AND sample.split='train')::integer AS trdg_train,
                   count(*) FILTER (WHERE sample.source_flow='FLOW2_TRDG' AND sample.split='validation')::integer AS trdg_validation
            FROM public.viread_ocr_dataset_versions version
            JOIN public.viread_ocr_samples sample ON sample.dataset_version_id=version.id
            WHERE version.source_flow='FLOW2_EXTERNAL_TRDG' AND version.is_locked_test=FALSE
            GROUP BY version.id ORDER BY version.created_at, version.id
            LIMIT 100
        """))
        datasets = [dict(row) for row in result.mappings().all()]
        selected = None
        counts = None
        for dataset in datasets:
            counts = {
                "FLOW2_EXTERNAL": dataset["external_count"],
                "FLOW2_TRDG": dataset["trdg_count"],
                "FLOW2_EXTERNAL_train": dataset["external_train"],
                "FLOW2_EXTERNAL_validation": dataset["external_validation"],
                "FLOW2_TRDG_train": dataset["trdg_train"],
                "FLOW2_TRDG_validation": dataset["trdg_validation"],
            }
            ready, _reason = flow1_dataset_readiness(counts)
            if ready:
                selected = dataset
                break
        if not selected:
            return 0
        parent = await db.execute(text("""
            SELECT checkpoint_sha256 FROM public.viread_ocr_active_model WHERE singleton=TRUE
        """))
        parent_sha = parent.scalar_one_or_none()
        if not parent_sha:
            return 0
        local_ready, hardware = await asyncio.to_thread(local_training_capacity)
        target = "LOCAL" if local_ready else "COLAB"
        initial_status = "QUEUED" if local_ready else "WAITING_FOR_COLAB_WORKER"
        repo_root = Path(__file__).resolve().parents[3]
        training_config, config_sha = _training_config("FLOW1_EXTERNAL_TRDG", repo_root)
        inserted = await db.execute(text("""
            INSERT INTO public.viread_ocr_training_jobs
                (profile, dataset_version_id, manifest_sha256, config_sha256, parent_checkpoint_sha256,
                 target, status, created_by, metadata)
            VALUES ('FLOW1_EXTERNAL_TRDG', :dataset_id, :manifest_sha, :config_sha, :parent_sha,
                    :target, :status, :actor_id, CAST(:metadata AS jsonb))
            ON CONFLICT (profile, dataset_version_id, manifest_sha256, config_sha256, parent_checkpoint_sha256)
            DO NOTHING
            RETURNING id
        """), {"dataset_id": selected["dataset_version_id"], "manifest_sha": selected["version_sha256"],
              "config_sha": config_sha, "parent_sha": parent_sha, "target": target, "status": initial_status,
              "actor_id": selected["created_by"], "metadata": json.dumps({
                  "hardware": hardware, "train_count": counts["FLOW2_EXTERNAL_train"] + counts["FLOW2_TRDG_train"],
                  "validation_count": counts["FLOW2_EXTERNAL_validation"] + counts["FLOW2_TRDG_validation"],
                  "components": {key: value for key, value in counts.items() if not key.endswith(("_train", "_validation"))},
                  "training_config": training_config})})
        await db.commit()
        return 1 if inserted.scalar_one_or_none() else 0


async def _schedule_ready_flow2() -> int:
    """Snapshot committed VERIFIED samples and enqueue one immutable Flow 2 job when splits are ready."""
    async with AsyncSessionLocal() as db:
        if await _has_unresolved_training_job(db):
            return 0
        actor = await db.execute(text("""
            SELECT actor_id FROM public.viread_ocr_outbox
            WHERE status='DONE' AND actor_id IS NOT NULL
            ORDER BY updated_at DESC LIMIT 1
        """))
        actor_id = actor.scalar_one_or_none()
        if actor_id is None:
            return 0
        overview = await VireadOcrTrainingService(db).admin_verified_manifest(
            actor_id, limit=1, offset=0
        )
        dataset_id = overview.get("dataset_version_id")
        manifest_sha = overview.get("manifest_sha256")
        if not dataset_id or not manifest_sha:
            return 0
        result = await db.execute(text("""
            SELECT count(*) FILTER (WHERE split='train')::integer AS train_count,
                   count(*) FILTER (WHERE split='validation')::integer AS validation_count
            FROM public.viread_ocr_samples WHERE dataset_version_id=:dataset_id
        """), {"dataset_id": dataset_id})
        counts = result.mappings().one()
        parent = await db.execute(text("""
            SELECT checkpoint_sha256 FROM public.viread_ocr_active_model WHERE singleton=TRUE
        """))
        parent_sha = parent.scalar_one_or_none()
        if not parent_sha:
            return 0
        has_splits = bool(counts["train_count"] and counts["validation_count"])
        if not has_splits:
            return 0
        local_ready, hardware = await asyncio.to_thread(local_training_capacity)
        target = "LOCAL" if local_ready else "COLAB"
        initial_status = "QUEUED" if local_ready else "WAITING_FOR_COLAB_WORKER"
        repo_root = Path(__file__).resolve().parents[3]
        training_config, config_sha = _training_config("FLOW2_ADMIN_VERIFIED", repo_root)
        inserted = await db.execute(text("""
            INSERT INTO public.viread_ocr_training_jobs
                (profile, dataset_version_id, manifest_sha256, config_sha256, parent_checkpoint_sha256,
                 target, status, created_by, metadata)
            VALUES ('FLOW2_ADMIN_VERIFIED', :dataset_id, :manifest_sha, :config_sha, :parent_sha,
                    :target, :status, :actor_id, CAST(:metadata AS jsonb))
            ON CONFLICT (profile, dataset_version_id, manifest_sha256, config_sha256, parent_checkpoint_sha256)
            DO NOTHING
            RETURNING id
        """), {"dataset_id": dataset_id, "manifest_sha": manifest_sha, "config_sha": config_sha,
              "parent_sha": parent_sha, "target": target, "status": initial_status,
              "actor_id": actor_id, "metadata": json.dumps({"hardware": hardware,
                                                                "train_count": counts["train_count"],
                                                                "validation_count": counts["validation_count"],
                                                                "training_config": training_config})})
        await db.commit()
        return 1 if inserted.scalar_one_or_none() else 0


async def _expire_exhausted_jobs() -> None:
    async with AsyncSessionLocal() as db:
        # Older free/manual Colab workers reported a failure, but the API stored
        # COLAB_EXECUTING even though no Google execution existed to poll. Repair
        # only terminal pre-run jobs with an error and no execution/run identity.
        await db.execute(text("""
            UPDATE public.viread_ocr_training_jobs
            SET status='FAILED', worker_id=NULL, lease_expires_at=NULL,
                progress='{"stage":"failed"}'::jsonb,
                metadata=metadata || '{"manual_colab_failure_reconciled":true}'::jsonb,
                updated_at=now()
            WHERE target='COLAB' AND status='COLAB_EXECUTING'
              AND last_error_code IS NOT NULL AND run_id IS NULL
              AND colab_execution_id IS NULL
              AND colab_execution_resource_name IS NULL
              AND colab_operation_name IS NULL
        """))
        await db.execute(text("""
            UPDATE public.viread_ocr_training_jobs
            SET status=CASE
                    WHEN colab_execution_id IS NOT NULL
                      OR colab_execution_resource_name IS NOT NULL
                      OR colab_operation_name IS NOT NULL
                    THEN 'COLAB_EXECUTING'
                    ELSE 'WAITING_FOR_COLAB_WORKER'
                END,
                worker_id=NULL, lease_expires_at=NULL,
                last_error_code=COALESCE(last_error_code, 'COLAB_WORKER_LEASE_EXPIRED'), updated_at=now()
            WHERE target='COLAB' AND status='COLAB_RUNNING'
              AND lease_expires_at < now() AND attempts < :max_attempts
        """), {"max_attempts": MAX_ATTEMPTS})
        await db.execute(text("""
            UPDATE public.viread_ocr_training_jobs
            SET status='FAILED', worker_id=NULL, lease_expires_at=NULL,
                last_error_code='WORKER_LEASE_EXPIRED_RETRY_LIMIT',
                progress='{"stage":"failed"}'::jsonb, updated_at=now()
            WHERE status IN ('LOCAL_RUNNING','COLAB_RUNNING')
              AND lease_expires_at < now() AND attempts >= :max_attempts
        """), {"max_attempts": MAX_ATTEMPTS})
        await db.commit()


async def _claim_local_job(worker_id: str) -> dict[str, Any] | None:
    ready, hardware = await asyncio.to_thread(local_training_capacity)
    if not ready:
        async with AsyncSessionLocal() as db:
            await db.execute(text("""
                UPDATE public.viread_ocr_training_jobs SET target='COLAB',
                    status='WAITING_FOR_COLAB_WORKER', metadata=metadata || CAST(:metadata AS jsonb),
                    updated_at=now()
                WHERE target='LOCAL' AND status='QUEUED'
                RETURNING id
            """), {"metadata": json.dumps({"local_unavailable": hardware.get("reason")})})
            expired = await db.execute(text("""
                SELECT id FROM public.viread_ocr_training_jobs
                WHERE target='LOCAL' AND status='LOCAL_RUNNING' AND lease_expires_at < now()
                  AND attempts < :max_attempts
            """), {"max_attempts": MAX_ATTEMPTS})
            expired_ids = [UUID(str(row["id"])) for row in expired.mappings().all()]
            work_root = _work_root() / "viread-vietocr-training"
            for job_id in expired_ids:
                resumable = (work_root / str(job_id) / "latest.pt").is_file()
                if resumable:
                    await db.execute(text("""
                        UPDATE public.viread_ocr_training_jobs SET status='BLOCKED',
                            worker_id=NULL, lease_expires_at=NULL,
                            last_error_code='LOCAL_RESUME_STATE_NOT_PORTABLE', updated_at=now()
                        WHERE id=:id
                    """), {"id": job_id})
                else:
                    await db.execute(text("""
                        UPDATE public.viread_ocr_training_jobs SET target='COLAB',
                            status='WAITING_FOR_COLAB_WORKER', worker_id=NULL,
                            lease_expires_at=NULL, metadata=metadata || CAST(:metadata AS jsonb),
                            updated_at=now() WHERE id=:id
                    """), {"id": job_id, "metadata": json.dumps({"local_unavailable": hardware.get("reason")})})
            await db.commit()
        return None
    async with AsyncSessionLocal() as db:
        result = await db.execute(text("""
            WITH next_job AS (
                SELECT id FROM public.viread_ocr_training_jobs
                WHERE target='LOCAL' AND available_at <= now() AND (
                    status='QUEUED' OR
                    (status='LOCAL_RUNNING' AND lease_expires_at < now())
                ) AND attempts < :max_attempts
                  AND NOT EXISTS (
                    SELECT 1 FROM public.viread_ocr_training_jobs running
                    WHERE running.status='LOCAL_RUNNING' AND running.lease_expires_at > now()
                  )
                ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
            )
            UPDATE public.viread_ocr_training_jobs AS job
            SET status='LOCAL_RUNNING', worker_id=:worker_id,
                lease_expires_at=now() + (:lease_seconds * interval '1 second'),
                attempts=job.attempts+1, progress='{"stage":"starting"}'::jsonb,
                metadata=job.metadata || CAST(:hardware AS jsonb), updated_at=now()
            FROM next_job WHERE job.id=next_job.id
            RETURNING job.id, job.dataset_version_id, job.manifest_sha256,
                      job.parent_checkpoint_sha256, job.created_by, job.attempts, job.run_id,
                      job.locked_test_version_id, job.locked_test_manifest_sha256, job.metadata
        """), {"max_attempts": MAX_ATTEMPTS, "worker_id": worker_id,
              "lease_seconds": LEASE_SECONDS, "hardware": json.dumps(hardware)})
        row = result.mappings().first()
        await db.commit()
        return dict(row) if row else None


async def _heartbeat(job_id: UUID, worker_id: str, stop: asyncio.Event, progress: dict[str, Any]) -> None:
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=60)
            return
        except TimeoutError:
            pass
        async with AsyncSessionLocal() as db:
            await db.execute(text("""
                UPDATE public.viread_ocr_training_jobs SET
                    lease_expires_at=now() + (:lease_seconds * interval '1 second'),
                    progress=CAST(:progress AS jsonb), updated_at=now()
                WHERE id=:id AND worker_id=:worker_id AND status='LOCAL_RUNNING'
            """), {"id": job_id, "worker_id": worker_id, "lease_seconds": LEASE_SECONDS,
                  "progress": json.dumps(progress)})
            await db.commit()


async def _materialize_dataset(job: dict[str, Any], run_dir: Path) -> tuple[Path, Path, Path]:
    from ai.vietocr_v2.contracts import write_jsonl

    async with AsyncSessionLocal() as db:
        dataset_result = await db.execute(text("""
            SELECT manifest_storage_path, version_sha256, source_flow
            FROM public.viread_ocr_dataset_versions WHERE id=:id AND is_locked_test=FALSE
        """), {"id": job["dataset_version_id"]})
        dataset = dataset_result.mappings().first()
        samples_result = await db.execute(text("""
            SELECT source_flow, source_group_id, split, image_storage_path,
                   image_sha256, label, source_annotation_id
            FROM public.viread_ocr_samples WHERE dataset_version_id=:id
              AND split IN ('train','validation')
            ORDER BY source_group_id, source_annotation_id, id
        """), {"id": job["dataset_version_id"]})
        samples = [dict(row) for row in samples_result.mappings().all()]
    if not dataset or dataset["version_sha256"] != job["manifest_sha256"]:
        raise ValueError("DATASET_MANIFEST_MISMATCH")
    if {row["split"] for row in samples} < {"train", "validation"}:
        raise ValueError("TRAIN_VALIDATION_REQUIRED")
    receipt_bytes = await asyncio.to_thread(download_object, dataset["manifest_storage_path"])
    if hashlib.sha256(receipt_bytes).hexdigest() != job["manifest_sha256"]:
        raise ValueError("DATASET_RECEIPT_HASH_MISMATCH")
    run_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = run_dir / "dataset-receipt.json"
    if not receipt_path.exists():
        receipt_path.write_bytes(receipt_bytes)
    image_dir = run_dir / "source-images"
    image_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for index, sample in enumerate(samples):
        image_path = image_dir / f"{sample['image_sha256']}.png"
        if not image_path.is_file():
            image_bytes = await asyncio.to_thread(download_object, sample["image_storage_path"])
            if hashlib.sha256(image_bytes).hexdigest() != sample["image_sha256"]:
                raise ValueError("DATASET_IMAGE_HASH_MISMATCH")
            image_path.write_bytes(image_bytes)
        rows.append({"image": image_path.as_posix(), "label": sample["label"],
                     "group_id": sample["source_group_id"], "source_flow": sample["source_flow"],
                     "split": sample["split"], "image_sha256": sample["image_sha256"],
                     "verified": sample["source_flow"] == "FLOW1_VERIFIED",
                     "annotation_id": sample["source_annotation_id"] or f"admin:{index}"})
    manifest_path = run_dir / "training.jsonl"
    write_jsonl(manifest_path, rows)
    return manifest_path, receipt_path, run_dir


async def _active_parent(job: dict[str, Any], run_dir: Path) -> str:
    async with AsyncSessionLocal() as db:
        result = await db.execute(text("""
            SELECT checkpoint_sha256, storage_path FROM public.viread_ocr_active_model
            WHERE singleton=TRUE
        """))
        active = result.mappings().first()
    if not active or active["checkpoint_sha256"] != job["parent_checkpoint_sha256"]:
        raise ValueError("ACTIVE_PARENT_CHANGED")
    if active["checkpoint_sha256"] == ORIGINAL_SHA256 and active["storage_path"] is None:
        return "original"
    if not active["storage_path"]:
        raise ValueError("ACTIVE_CHECKPOINT_STORAGE_MISSING")
    raw = await asyncio.to_thread(download_object, active["storage_path"])
    artifact = json.loads(raw)
    if artifact.get("checkpoint_sha256") != active["checkpoint_sha256"]:
        raise ValueError("ACTIVE_CHECKPOINT_MANIFEST_MISMATCH")
    output = run_dir / "parent-v2.pth"
    digest = hashlib.sha256()
    with output.open("wb") as stream:
        for chunk in artifact.get("chunks", []):
            data = await asyncio.to_thread(download_object, chunk["path"])
            if len(data) != int(chunk["bytes"]) or hashlib.sha256(data).hexdigest() != chunk["sha256"]:
                raise ValueError("ACTIVE_CHECKPOINT_SHARD_MISMATCH")
            stream.write(data)
            digest.update(data)
    if digest.hexdigest() != active["checkpoint_sha256"]:
        raise ValueError("ACTIVE_CHECKPOINT_HASH_MISMATCH")
    return str(output)


async def _register_candidate(job: dict[str, Any], candidate: dict[str, Any]) -> UUID:
    from app.schemas.viread_ocr_training import TrainingRunComplete, TrainingRunCreate

    actor_id = UUID(str(job["created_by"]))
    async with AsyncSessionLocal() as db:
        service = VireadOcrTrainingService(db)
        if job.get("run_id"):
            run_id = UUID(str(job["run_id"]))
        else:
            created = await service.create_run(actor_id, TrainingRunCreate(
                profile=job["profile"], dataset_version_id=job["dataset_version_id"],
                parent_checkpoint_sha256=candidate["parent_checkpoint_sha256"],
                manifest_sha256=candidate["manifest_sha256"], config_sha256=candidate["config_sha256"],
                architecture_sha256=candidate["architecture_sha256"], vocabulary_sha256=candidate["vocabulary_sha256"],
            ))
            run_id = UUID(str(created["run_id"]))
            await db.execute(text("UPDATE public.viread_ocr_training_jobs SET run_id=:run_id WHERE id=:id"),
                             {"run_id": run_id, "id": UUID(str(job["id"]))})
            await db.commit()
        existing_run = await service.repo.one("SELECT status FROM public.viread_ocr_training_runs WHERE id=:id", {"id": run_id})
        path = Path(candidate["candidate_path"])
        if existing_run and existing_run["status"] not in {"CANDIDATE", "BENCHMARKED"}:
            with path.open("rb") as stream:
                chunk_index = 0
                while data := stream.read(MAX_SHARD_BYTES):
                    await service.upload_checkpoint_chunk(actor_id, run_id, chunk_index, data)
                    chunk_index += 1
            await service.complete_run(actor_id, run_id, TrainingRunComplete(
                profile=job["profile"], parent_checkpoint_sha256=candidate["parent_checkpoint_sha256"],
                manifest_sha256=candidate["manifest_sha256"], config_sha256=candidate["config_sha256"],
                architecture_sha256=candidate["architecture_sha256"], vocabulary_sha256=candidate["vocabulary_sha256"],
                checkpoint_sha256=candidate["checkpoint_sha256"], checkpoint_bytes=path.stat().st_size,
                step=candidate["steps"],
            ))
        elif existing_run and existing_run["status"] == "CANDIDATE":
            await service.complete_run(actor_id, run_id, TrainingRunComplete(
                profile=job["profile"], parent_checkpoint_sha256=candidate["parent_checkpoint_sha256"],
                manifest_sha256=candidate["manifest_sha256"], config_sha256=candidate["config_sha256"],
                architecture_sha256=candidate["architecture_sha256"], vocabulary_sha256=candidate["vocabulary_sha256"],
                checkpoint_sha256=candidate["checkpoint_sha256"], checkpoint_bytes=path.stat().st_size,
                step=candidate["steps"],
            ))
        await db.execute(text("""
            UPDATE public.viread_ocr_training_runs SET metadata=metadata || CAST(:metadata AS jsonb)
            WHERE id=:run_id
        """), {"run_id": run_id, "metadata": json.dumps({
            "execution_target": "LOCAL", "training_job_id": str(job["id"]),
            "runtime": {key: job.get("metadata", {}).get("hardware", {}).get(key)
                        for key in ("device", "cuda_version", "torch_version", "vram_free_bytes",
                                    "vram_total_bytes", "ram_available_bytes", "disk_free_bytes")
                        if job.get("metadata", {}).get("hardware", {}).get(key) is not None},
        })})
        await db.commit()
        return run_id


async def _benchmark_candidate(job: dict[str, Any], run_id: UUID, candidate_path: Path, run_dir: Path) -> dict[str, Any] | None:
    from app.schemas.viread_ocr_training import BenchmarkCreate, BenchmarkOutput
    from ai.vietocr_v2.contracts import ORIGINAL_CHECKPOINT_SHA256

    actor_id = UUID(str(job["created_by"]))
    async with AsyncSessionLocal() as db:
        result = await db.execute(text("""
            SELECT id, version_sha256, manifest_storage_path FROM public.viread_ocr_dataset_versions
            WHERE source_flow='LOCKED_TEST' AND is_locked_test=TRUE
              AND (:locked_id IS NULL OR id=:locked_id)
            ORDER BY created_at DESC LIMIT 1
        """), {"locked_id": job.get("locked_test_version_id")})
        locked = result.mappings().first()
        if not locked:
            return None
        if job.get("locked_test_manifest_sha256") and locked["version_sha256"] != job["locked_test_manifest_sha256"]:
            raise ValueError("LOCKED_TEST_VERSION_CHANGED")
        await db.execute(text("""
            UPDATE public.viread_ocr_training_jobs SET locked_test_version_id=:test_id,
                locked_test_manifest_sha256=:test_sha, updated_at=now() WHERE id=:job_id
        """), {"test_id": locked["id"], "test_sha": locked["version_sha256"],
              "job_id": UUID(str(job["id"]))})
        await db.commit()
        rows_result = await db.execute(text("""
            SELECT source_annotation_id AS sample_id, source_group_id AS group_id,
                   image_storage_path, image_sha256
            FROM public.viread_ocr_samples
            WHERE dataset_version_id=:dataset_id AND source_flow='LOCKED_TEST'
              AND split='locked_test' ORDER BY source_group_id, source_annotation_id, id
        """), {"dataset_id": locked["id"]})
        locked_rows = [dict(row) for row in rows_result.mappings().all()]
    receipt_bytes = await asyncio.to_thread(download_object, locked["manifest_storage_path"])
    if hashlib.sha256(receipt_bytes).hexdigest() != locked["version_sha256"]:
        raise ValueError("LOCKED_TEST_RECEIPT_HASH_MISMATCH")
    receipt_path = run_dir / "locked-test-receipt.json"
    if not receipt_path.exists():
        receipt_path.write_bytes(receipt_bytes)
    cache = run_dir / "locked-test-images"
    cache.mkdir(parents=True, exist_ok=True)
    for row in locked_rows:
        image_path = cache / row["image_sha256"]
        if not image_path.is_file():
            data = await asyncio.to_thread(download_object, row["image_storage_path"])
            if hashlib.sha256(data).hexdigest() != row["image_sha256"]:
                raise ValueError("LOCKED_TEST_IMAGE_HASH_MISMATCH")
            image_path.write_bytes(data)
    original_path = run_dir / f"original-{ORIGINAL_CHECKPOINT_SHA256}.pth"
    if not original_path.exists():
        from vietocr.tool.utils import download_weights
        downloaded = Path(await asyncio.to_thread(download_weights,
                                                   "https://vocr.vn/data/vietocr/vgg_transformer.pth", quiet=True))
        if hashlib.sha256(downloaded.read_bytes()).hexdigest() != ORIGINAL_CHECKPOINT_SHA256:
            raise ValueError("ORIGINAL_CHECKPOINT_HASH_MISMATCH")
        shutil.copyfile(downloaded, original_path)
    if hashlib.sha256(original_path.read_bytes()).hexdigest() != ORIGINAL_CHECKPOINT_SHA256:
        raise ValueError("ORIGINAL_CHECKPOINT_HASH_MISMATCH")
    from ai.vietocr_v2.benchmark import run_locked_benchmark
    report_path = run_dir / "locked-test-report.json"
    if report_path.exists():
        report = json.loads(report_path.read_text(encoding="utf-8"))
    else:
        report = await asyncio.to_thread(
            run_locked_benchmark, manifest_path=str(receipt_path),
            expected_manifest_sha256=locked["version_sha256"],
            original_checkpoint=str(original_path), candidate_checkpoint=str(candidate_path),
                candidate_profile=job["profile"], output_path=str(report_path),
            image_cache_dir=str(cache),
        )
    if (report.get("candidate_checkpoint_sha256") != hashlib.sha256(candidate_path.read_bytes()).hexdigest()
            or report.get("locked_manifest_sha256") != locked["version_sha256"]):
        raise ValueError("BENCHMARK_CANDIDATE_HASH_MISMATCH")
    outputs = [BenchmarkOutput(sample_id=item["sample_id"], group_id=item["group_id"],
                               original=item["original"], candidate=item["candidate"])
               for item in report.get("outputs", [])]
    async with AsyncSessionLocal() as db:
        prior = await db.execute(text("""
            SELECT status FROM public.viread_ocr_training_runs WHERE id=:id
        """), {"id": run_id})
        prior_run = prior.mappings().first()
        if prior_run and prior_run["status"] == "BENCHMARKED":
            benchmark_row = await db.execute(text("""
                SELECT gate_status FROM public.viread_ocr_benchmarks WHERE run_id=:run_id
                ORDER BY created_at DESC LIMIT 1
            """), {"run_id": run_id})
            gate = benchmark_row.scalar_one_or_none()
            return {"gate_status": gate or "BENCHMARKED", "promotion_allowed": gate == "V2_WIN"}
        service = VireadOcrTrainingService(db)
        registered = await service.benchmark(actor_id, BenchmarkCreate(
            run_id=run_id, locked_test_version_id=locked["id"],
            locked_test_manifest_sha256=locked["version_sha256"], outputs=outputs,
        ))
    return registered


async def _process_local_job(job: dict[str, Any], progress: dict[str, Any]) -> None:
    job_id = UUID(str(job["id"]))
    work_root = _work_root() / "viread-vietocr-training"
    run_dir = work_root / str(job_id)
    manifest, receipt, run_dir = await _materialize_dataset(job, run_dir)
    parent = await _active_parent(job, run_dir)
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA_UNAVAILABLE_AFTER_CLAIM")
    candidate_record = run_dir / "candidate.json"
    stable_candidate = run_dir / "candidate.pth"
    if candidate_record.is_file() and stable_candidate.is_file():
        candidate = json.loads(candidate_record.read_text(encoding="utf-8"))
        if hashlib.sha256(stable_candidate.read_bytes()).hexdigest() != candidate.get("checkpoint_sha256"):
            raise ValueError("PERSISTED_CANDIDATE_HASH_MISMATCH")
        candidate["candidate_path"] = str(stable_candidate)
    else:
        config = job.get("metadata", {}).get("training_config")
        if not isinstance(config, dict):
            raise ValueError("TRAINING_CONFIG_MISSING")
        repo_root = Path(__file__).resolve().parents[3]
        if (hashlib.sha256((repo_root / "ai" / "vietocr_v2" / "train.py").read_bytes()).hexdigest()
                != config.get("trainer_sha256")
                or hashlib.sha256((repo_root / "ai" / "vietocr_v2" / "requirements.txt").read_bytes()).hexdigest()
                != config.get("requirements_sha256")
                or hashlib.sha256((repo_root / "ai" / "vietocr_v2" / "requirements-colab.txt").read_bytes()).hexdigest()
                != config.get("colab_requirements_sha256")):
            raise ValueError("WORKER_CODE_OR_DEPENDENCY_LOCK_MISMATCH")
        from ai.vietocr_v2.train import run_training
        progress.update({"stage": "training", "completed_steps": 0,
                         "total_steps": int(config["steps"])})
        candidate = await asyncio.to_thread(
            run_training, profile=job["profile"], manifest_path=str(manifest),
            output_dir=str(run_dir), parent_checkpoint=parent,
            total_steps=int(config["steps"]),
            dataset_receipt_path=str(receipt), dataset_version_sha256=job["manifest_sha256"],
            batch_size=int(config["batch_size"]), seed=int(config["seed"]),
            resume=(run_dir / "latest.pt").is_file(),
            freeze_epochs=int(config["freeze_epochs"]), use_fp16=bool(config["fp16"]),
            progress_callback=lambda completed, total: progress.update(
                {"stage": "training", "completed_steps": completed, "total_steps": total}),
        )
        shutil.copyfile(candidate["candidate_path"], stable_candidate)
        candidate["candidate_path"] = str(stable_candidate)
        candidate_record.write_text(json.dumps(candidate, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    run_id = await _register_candidate(job, candidate)
    benchmark = await _benchmark_candidate(job, run_id, stable_candidate, run_dir)
    final_status = ("BENCHMARKED" if benchmark and benchmark.get("gate_status") == "V2_WIN"
                    else "QUALITY_GATE_REJECTED" if benchmark else "CANDIDATE")
    await _set_job(job_id, status=final_status, run_id=run_id,
                   metadata={"device": candidate.get("device"), "steps": candidate.get("steps"),
                             "checkpoint_sha256": candidate.get("checkpoint_sha256"),
                             "benchmark_status": benchmark.get("gate_status") if benchmark else "WAITING_FOR_LOCKED_TEST"})


async def _run_local_once(worker_id: str) -> bool:
    job = await _claim_local_job(worker_id)
    if not job:
        return False
    job_id = UUID(str(job["id"]))
    heartbeat_stop = asyncio.Event()
    progress: dict[str, Any] = {"stage": "preparing"}
    heartbeat = asyncio.create_task(_heartbeat(job_id, worker_id, heartbeat_stop, progress))
    try:
        await _process_local_job(job, progress)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        error_code = type(exc).__name__[:64]
        resource_failure = any(term in str(exc).upper() for term in ("CUDA", "OUT OF MEMORY", "VRAM"))
        work_root = _work_root() / "viread-vietocr-training" / str(job_id)
        if resource_failure and not (work_root / "latest.pt").is_file():
            await _set_job(job_id, status="FALLBACK_QUEUED_COLAB", target="COLAB",
                           error_code=error_code,
                           metadata={"fallback_reason": error_code})
        elif resource_failure:
            await _set_job(job_id, status="BLOCKED", error_code="LOCAL_RESUME_STATE_NOT_PORTABLE",
                           metadata={"fallback_blocked_reason": "LOCAL_RESUME_STATE_NOT_PORTABLE"})
        elif "ACTIVE_PARENT_CHANGED" in str(exc):
            await _set_job(job_id, status="BLOCKED", error_code="ACTIVE_PARENT_CHANGED")
        elif isinstance(exc, (TimeoutError, OSError, ConnectionError)) and int(job["attempts"]) < MAX_ATTEMPTS:
            delay = min(300, 30 * 2 ** max(0, int(job["attempts"]) - 1))
            await _set_job(job_id, status="QUEUED", error_code=error_code, retry_delay=delay,
                           metadata={"retry_in_seconds": delay, "failure_attempt": int(job["attempts"])})
        else:
            await _set_job(job_id, status="FAILED", error_code=error_code,
                           metadata={"failure_attempt": int(job["attempts"]), "retry_limit": MAX_ATTEMPTS})
        log_diagnostic(logger, logging.ERROR, event="viread_local_training_failed",
                       stage="training_run", exception=exc, job_id=str(job_id),
                       fallback=resource_failure)
    finally:
        heartbeat_stop.set()
        await asyncio.gather(heartbeat, return_exceptions=True)
    return True


async def _dispatch_or_poll_colab_once() -> bool:
    """Submit or poll exactly one Colab Enterprise execution, with a stable per-attempt ID."""
    from app.services.viread_colab_enterprise import (
        ColabEnterpriseConfigurationError,
        ColabEnterpriseDispatchError,
        ColabEnterpriseDispatcher,
        enterprise_configuration,
        new_execution_id,
    )

    try:
        config = enterprise_configuration()
    except ColabEnterpriseConfigurationError as exc:
        async with AsyncSessionLocal() as db:
            await db.execute(text("""
                UPDATE public.viread_ocr_training_jobs
                SET status='BLOCKED_CONFIGURATION', last_error_code=:error_code,
                    progress='{"stage":"blocked_configuration"}'::jsonb,
                    metadata=metadata || CAST(:metadata AS jsonb), updated_at=now()
                WHERE target='COLAB' AND status IN ('WAITING_FOR_COLAB_WORKER','FALLBACK_QUEUED_COLAB')
            """), {"error_code": exc.code, "metadata": json.dumps({
                "configuration_help": "docs/viread-colab-enterprise-setup.md"})})
            await db.commit()
        return False

    if config["mode"] == "manual":
        async with AsyncSessionLocal() as db:
            await db.execute(text("""
                UPDATE public.viread_ocr_training_jobs
                SET status='WAITING_FOR_COLAB_WORKER', last_error_code=NULL,
                    progress='{"stage":"waiting_for_manual_colab_worker"}'::jsonb, updated_at=now()
                WHERE target='COLAB' AND status='BLOCKED_CONFIGURATION'
            """))
            await db.commit()
        return False
    if config["mode"] == "disabled":
        return False

    async with AsyncSessionLocal() as db:
        # Recover a scheduler crash between reserving an id and calling Cloud Run.
        await db.execute(text("""
            UPDATE public.viread_ocr_training_jobs
            SET status='WAITING_FOR_COLAB_WORKER', updated_at=now()
            WHERE target='COLAB' AND status='COLAB_SUBMITTING'
              AND updated_at < now() - interval '2 minutes'
        """))
        await db.execute(text("""
            UPDATE public.viread_ocr_training_jobs
            SET status='WAITING_FOR_COLAB_WORKER', last_error_code=NULL,
                progress='{"stage":"colab_configuration_recheck"}'::jsonb, updated_at=now()
            WHERE target='COLAB' AND status='BLOCKED_CONFIGURATION'
              AND updated_at < now() - interval '5 minutes'
        """))

        poll_result = await db.execute(text("""
            SELECT id, colab_execution_id, colab_execution_resource_name,
                   colab_operation_name, status, colab_execution_number, run_id
            FROM public.viread_ocr_training_jobs
            WHERE target='COLAB' AND status IN ('COLAB_SUBMITTED','COLAB_EXECUTING')
            ORDER BY colab_submitted_at NULLS FIRST, created_at, id
            FOR UPDATE SKIP LOCKED LIMIT 1
        """))
        poll_job = poll_result.mappings().first()
        if poll_job:
            await db.commit()
        else:
            result = await db.execute(text("""
                SELECT job.id, job.profile, job.attempts, job.dataset_version_id,
                       job.colab_execution_id, job.colab_execution_number, job.run_id, job.metadata
                FROM public.viread_ocr_training_jobs job
                WHERE job.target='COLAB' AND job.available_at <= now()
                  AND job.status IN ('WAITING_FOR_COLAB_WORKER','FALLBACK_QUEUED_COLAB')
                  AND job.attempts < :max_attempts
                  AND NOT EXISTS (
                    SELECT 1 FROM public.viread_ocr_training_jobs other
                    WHERE other.id <> job.id AND other.status IN (
                        'QUEUED','LOCAL_RUNNING','FALLBACK_QUEUED_COLAB','COLAB_RUNNING',
                        'WAITING_FOR_COLAB_WORKER','COLAB_SUBMITTING','COLAB_SUBMITTED',
                        'COLAB_EXECUTING','BLOCKED_CONFIGURATION','BLOCKED','CANDIDATE','BENCHMARKED'
                    )
                  )
                ORDER BY job.created_at, job.id
                FOR UPDATE OF job SKIP LOCKED LIMIT 1
            """), {"max_attempts": MAX_ATTEMPTS})
            row = result.mappings().first()
            if not row:
                await db.commit()
                return False
            if row["colab_execution_number"] == 0 and row["run_id"] is None:
                dataset_count = await db.execute(text("""
                    SELECT dataset.sample_count,
                           count(sample.id)::integer AS materialized_count
                    FROM public.viread_ocr_dataset_versions dataset
                    LEFT JOIN public.viread_ocr_samples sample
                      ON sample.dataset_version_id=dataset.id
                    WHERE dataset.id=:dataset_id
                    GROUP BY dataset.sample_count
                """), {"dataset_id": row["dataset_version_id"]})
                count_row = dataset_count.mappings().first()
                declared_count = int(count_row["sample_count"]) if count_row else -1
                materialized_count = int(count_row["materialized_count"]) if count_row else None
                if not dataset_snapshot_count_matches(declared_count, materialized_count):
                    await db.execute(text("""
                        UPDATE public.viread_ocr_training_jobs
                        SET status='FAILED', last_error_code='DATASET_SAMPLE_COUNT_MISMATCH',
                            progress='{"stage":"dataset_integrity_check_failed"}'::jsonb,
                            updated_at=now()
                        WHERE id=:id AND status IN ('WAITING_FOR_COLAB_WORKER','FALLBACK_QUEUED_COLAB')
                          AND colab_execution_number=0 AND run_id IS NULL
                    """), {"id": row["id"]})
                    await db.commit()
                    return True
            execution_id = row["colab_execution_id"] or new_execution_id(
                str(row["id"]), int(row["colab_execution_number"]) + 1
            )
            selected = await db.execute(text("""
                UPDATE public.viread_ocr_training_jobs
                SET status='COLAB_SUBMITTING', colab_execution_id=:execution_id,
                    colab_execution_number=CASE WHEN colab_execution_id IS NULL
                        THEN colab_execution_number+1 ELSE colab_execution_number END,
                    colab_dispatch_attempts=colab_dispatch_attempts+1,
                    last_error_code=NULL,
                    metadata=metadata || CAST(:metadata AS jsonb),
                    progress='{"stage":"submitting_colab_enterprise"}'::jsonb,
                    updated_at=now()
                WHERE id=:id
                RETURNING id, profile, status, colab_execution_id, metadata
            """), {"id": row["id"], "execution_id": execution_id,
                  "metadata": json.dumps({"repository_commit": config["repository_commit"],
                                          "repository_url": config["repository_url"]})})
            poll_job = selected.mappings().one()
            await db.commit()

    if poll_job["status"] in {"COLAB_SUBMITTED", "COLAB_EXECUTING"}:
        client = ColabEnterpriseDispatcher(config)
        try:
            state = await asyncio.to_thread(client.status,
                execution_id=poll_job["colab_execution_id"],
                operation_name=poll_job["colab_operation_name"])
        except ColabEnterpriseDispatchError as exc:
            async with AsyncSessionLocal() as db:
                await db.execute(text("""
                    UPDATE public.viread_ocr_training_jobs
                    SET last_error_code=:error_code, colab_last_polled_at=now(), updated_at=now()
                    WHERE id=:id AND colab_execution_id=:execution_id
                """), {"id": poll_job["id"], "execution_id": poll_job["colab_execution_id"],
                      "error_code": exc.code})
                await db.commit()
            return False
        job_state = str(state.get("job_state", "JOB_STATE_PENDING")).upper()
        if job_state in {"JOB_STATE_SUCCEEDED", "JOB_STATE_COMPLETED"}:
            next_status, error_code = "BLOCKED", "COLAB_EXECUTION_FINISHED_WITHOUT_JOB_RESULT"
        elif job_state in {"JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED", "JOB_STATE_DELETED"}:
            next_status, error_code = colab_failure_action(
                int(poll_job["colab_execution_number"]), poll_job["run_id"]
            )
        elif job_state in {"JOB_STATE_RUNNING", "JOB_STATE_CANCELLING"}:
            next_status, error_code = "COLAB_EXECUTING", None
        else:
            next_status, error_code = "COLAB_SUBMITTED", None
        async with AsyncSessionLocal() as db:
            if next_status == "WAITING_FOR_COLAB_WORKER":
                history = json.dumps({"execution_id": poll_job["colab_execution_id"],
                                      "resource_name": poll_job["colab_execution_resource_name"],
                                      "state": job_state, "error_code": error_code})
                delay = min(900, 60 * 2 ** max(0, int(poll_job["colab_execution_number"]) - 1))
                await db.execute(text("""
                    UPDATE public.viread_ocr_training_jobs SET status=:status,
                        colab_execution_id=NULL, colab_execution_resource_name=NULL,
                        colab_operation_name=NULL, colab_submitted_at=NULL,
                        available_at=now() + (:delay * interval '1 second'),
                        last_error_code=:error_code, colab_last_polled_at=now(),
                        metadata=jsonb_set(metadata, '{colab_execution_history}',
                            COALESCE(metadata->'colab_execution_history','[]'::jsonb) ||
                            jsonb_build_array(CAST(:history AS jsonb)), true), updated_at=now()
                    WHERE id=:id AND colab_execution_id=:execution_id
                """), {"id": poll_job["id"], "execution_id": poll_job["colab_execution_id"],
                      "status": next_status, "delay": delay, "error_code": error_code,
                      "history": history})
            else:
                await db.execute(text("""
                    UPDATE public.viread_ocr_training_jobs SET status=:status,
                        last_error_code=:error_code, colab_last_polled_at=now(),
                        progress=CAST(:progress AS jsonb), updated_at=now()
                    WHERE id=:id AND colab_execution_id=:execution_id
                      AND status IN ('COLAB_SUBMITTED','COLAB_EXECUTING')
                """), {"id": poll_job["id"], "execution_id": poll_job["colab_execution_id"],
                      "status": next_status, "error_code": error_code,
                      "progress": json.dumps({"stage": job_state.lower(),
                          "colab_execution_resource_name": poll_job["colab_execution_resource_name"]})})
            await db.commit()
        return True

    job_id = str(poll_job["id"])
    client = ColabEnterpriseDispatcher(config)
    try:
        response = await asyncio.to_thread(
            client.dispatch, job_id=job_id, execution_id=poll_job["colab_execution_id"],
            profile=poll_job["profile"], repository_url=config["repository_url"],
            repository_commit=config["repository_commit"],
        )
        resource_name = str(response.get("resource_name", ""))
        if not resource_name.startswith("projects/") or "/notebookExecutionJobs/" not in resource_name:
            raise ColabEnterpriseDispatchError("COLAB_DISPATCH_INVALID_RESOURCE", retryable=False)
        async with AsyncSessionLocal() as db:
            await db.execute(text("""
            UPDATE public.viread_ocr_training_jobs SET
                status=CASE WHEN status='COLAB_SUBMITTING' THEN 'COLAB_SUBMITTED' ELSE status END,
                colab_execution_resource_name=:resource_name,
                colab_operation_name=:operation_name, colab_submitted_at=COALESCE(colab_submitted_at, now()),
                colab_last_polled_at=now(), last_error_code=NULL,
                progress=CASE WHEN status='COLAB_SUBMITTING'
                    THEN '{"stage":"colab_enterprise_submitted"}'::jsonb ELSE progress END,
                updated_at=now()
            WHERE id=:id AND colab_execution_id=:execution_id
              AND status IN ('COLAB_SUBMITTING','COLAB_RUNNING')
            """), {"id": poll_job["id"], "execution_id": poll_job["colab_execution_id"],
                  "resource_name": resource_name,
                  "operation_name": response.get("operation_name")})
            await db.commit()
        return True
    except ColabEnterpriseDispatchError as exc:
        terminal = not exc.retryable
        async with AsyncSessionLocal() as db:
            await db.execute(text("""
                UPDATE public.viread_ocr_training_jobs SET
                    status=CASE WHEN :terminal THEN 'BLOCKED_CONFIGURATION'
                                WHEN colab_dispatch_attempts >= :max_attempts THEN 'FAILED'
                                ELSE 'WAITING_FOR_COLAB_WORKER' END,
                    last_error_code=:error_code,
                    available_at=now() + (CASE WHEN :terminal THEN 0
                        ELSE LEAST(900, 30 * power(2, GREATEST(0, colab_dispatch_attempts-1))) END * interval '1 second'),
                    progress=CAST(:progress AS jsonb), updated_at=now()
                WHERE id=:id AND colab_execution_id=:execution_id AND status='COLAB_SUBMITTING'
            """), {"id": poll_job["id"], "execution_id": poll_job["colab_execution_id"],
                  "terminal": terminal, "error_code": exc.code, "max_attempts": MAX_ATTEMPTS,
                  "progress": json.dumps({"stage": "dispatch_retry" if exc.retryable else "blocked_configuration"})})
            await db.commit()
        return True


async def run_worker(stop: asyncio.Event, *, poll_seconds: int = POLL_SECONDS) -> None:
    while not stop.is_set():
        try:
            await _expire_exhausted_jobs()
            await _schedule_ready_flow1()
            await _schedule_ready_flow2()
            did_work = await _dispatch_or_poll_colab_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log_diagnostic(logger, logging.ERROR, event="viread_training_scheduler_failed",
                           stage="automatic_dataset_schedule_or_colab_dispatch", exception=exc)
            did_work = False
        if did_work:
            continue
        try:
            await asyncio.wait_for(stop.wait(), timeout=poll_seconds)
        except TimeoutError:
            pass


async def run_local_training_worker(stop: asyncio.Event, *, poll_seconds: int = POLL_SECONDS) -> None:
    """Dedicated process entrypoint for capable local GPUs; never called by the API lifespan."""
    worker_id = f"viread-local-{uuid4()}"
    while not stop.is_set():
        try:
            did_work = await _run_local_once(worker_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log_diagnostic(logger, logging.ERROR, event="viread_local_training_worker_failed",
                           stage="local_training", exception=exc)
            did_work = False
        if not did_work:
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll_seconds)
            except TimeoutError:
                pass
