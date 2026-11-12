from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.schemas.viread_ocr_training import (
    BenchmarkCreate,
    DatasetImport,
    ModelDecisionRequest,
    TrainingRunComplete,
    TrainingRunCreate,
)
from app.services.viread_ocr_training_service import MAX_SHARD_BYTES, VireadOcrTrainingService

router = APIRouter()


@router.get("/admin/viread-training/overview")
async def get_viread_training_overview(
    actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db),
):
    return await VireadOcrTrainingService(db).overview(actor_id)


@router.get("/admin/viread-training/datasets/flow1")
async def get_flow1_training_manifest(
    limit: int = 200,
    offset: int = 0,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    if not 1 <= limit <= 200 or offset < 0:
        raise HTTPException(status_code=422, detail="limit must be 1-200 and offset must be non-negative")
    return await VireadOcrTrainingService(db).flow1_manifest(actor_id, limit=limit, offset=offset)


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
