"""HTTP routes for Unified Global AI Task Center & AI Capability Health (mounted at /studio)."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db, require_admin_id
from app.schemas.global_tasks import (
    CapabilitiesHealthResponse,
    GlobalTaskActionResponse,
    GlobalTaskCreateRequest,
    GlobalTaskListResponse,
    ReconcileTasksResponse,
)
from app.services.global_tasks_service import GlobalTasksService

router = APIRouter()

_PRIVATE_NO_STORE_HEADERS = {
    "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Vary": "Authorization",
}


def _apply_no_store(response: Response) -> None:
    for key, value in _PRIVATE_NO_STORE_HEADERS.items():
        response.headers[key] = value


@router.get("/tasks", response_model=GlobalTaskListResponse)
async def list_global_tasks(
    response: Response,
    limit: int = Query(default=40, ge=1, le=100),
    active_only: bool = Query(default=False),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> GlobalTaskListResponse:
    """List actor-scoped durable studio tasks & active background workflows."""
    _apply_no_store(response)
    return await GlobalTasksService(db).list_tasks(
        actor_id=actor_id,
        limit=limit,
        active_only=active_only,
    )


@router.post(
    "/tasks",
    response_model=GlobalTaskActionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_global_task(
    payload: GlobalTaskCreateRequest,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> GlobalTaskActionResponse:
    """Create a durable idempotent studio job deduplicated on `(actor_id, idempotency_key)`."""
    _apply_no_store(response)
    result = await GlobalTasksService(db).create_task(
        actor_id=actor_id,
        payload=payload,
    )
    if result.deduplicated:
        response.status_code = status.HTTP_200_OK
    return result


@router.post("/tasks/{job_id}/retry", response_model=GlobalTaskActionResponse)
async def retry_global_task(
    job_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> GlobalTaskActionResponse:
    """Ownership-verified retry resuming from persisted checkpoints."""
    _apply_no_store(response)
    return await GlobalTasksService(db).retry_task(actor_id=actor_id, job_id=job_id)


@router.post("/tasks/{job_id}/cancel", response_model=GlobalTaskActionResponse)
async def cancel_global_task(
    job_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> GlobalTaskActionResponse:
    """Ownership-verified cooperative cancellation (`CANCELLED` or `CANCEL_REQUESTED`)."""
    _apply_no_store(response)
    return await GlobalTasksService(db).cancel_task(actor_id=actor_id, job_id=job_id)


@router.post("/tasks/reconcile", response_model=ReconcileTasksResponse)
async def reconcile_global_tasks(
    response: Response,
    _admin_id: UUID = Depends(require_admin_id),
    db: AsyncSession = Depends(get_db),
) -> ReconcileTasksResponse:
    """Admin-only manual trigger for expired-lease reclamation, revision fencing, and R-01 healing."""
    _apply_no_store(response)
    return await GlobalTasksService(db).reconcile_stale_jobs()


@router.get("/capabilities", response_model=CapabilitiesHealthResponse)
async def get_studio_capabilities(
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
) -> CapabilitiesHealthResponse:
    """Real-time AI provider capability matrix & circuit-breaker health (zero secrets)."""
    _apply_no_store(response)
    return await GlobalTasksService(db).get_capabilities(actor_id=actor_id)
