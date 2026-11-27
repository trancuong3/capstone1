"""HTTP routes for Unified Global AI Task Center & AI Capability Health (mounted at /studio)."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db, require_admin_id
from app.schemas.global_tasks import (
    ActorRole,
    CapabilitiesHealthResponse,
    GlobalTaskActionResponse,
    GlobalTaskCreateRequest,
    GlobalTaskItem,
    GlobalTaskListResponse,
    ReconcileTasksResponse,
)
from app.services.global_tasks_service import GlobalTasksService
from app.services.rate_limiter import rate_limit

router = APIRouter()

_PRIVATE_NO_STORE_HEADERS = {
    "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Vary": "Authorization",
}


def _apply_no_store(response: Response) -> None:
    for key, value in _PRIVATE_NO_STORE_HEADERS.items():
        response.headers[key] = value


def _unwrap_limit(limit: object, default: int = 40) -> int:
    if isinstance(limit, bool) or not isinstance(limit, int):
        return default
    return max(1, min(limit, 100))


def _unwrap_bool(value: object, default: bool = False) -> bool:
    return value if isinstance(value, bool) else default


def _unwrap_portal(portal: object) -> ActorRole | None:
    if isinstance(portal, str) and portal in ("admin", "parent"):
        return portal  # type: ignore[return-value]
    return None


# ---------------------------------------------------------------------------
# Dedicated Admin Portal AI Task Routes (/studio/admin/tasks*)
# ---------------------------------------------------------------------------


@router.get("/admin/tasks", response_model=GlobalTaskListResponse)
async def list_admin_global_tasks(
    response: Response,
    limit: int = Query(default=40, ge=1, le=100),
    active_only: bool = Query(default=False),
    admin_id: UUID = Depends(require_admin_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(
        rate_limit("studio_tasks_read", default_max=180, default_window=60.0, actor_dependency=require_admin_id)
    ),
) -> GlobalTaskListResponse:
    """List tasks strictly scoped to the authenticated Admin actor and Admin portal."""
    _apply_no_store(response)
    return await GlobalTasksService(db).list_tasks(
        actor_id=admin_id,
        limit=_unwrap_limit(limit),
        active_only=_unwrap_bool(active_only),
        portal="admin",
    )


@router.post(
    "/admin/tasks",
    response_model=GlobalTaskActionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_admin_global_task(
    payload: GlobalTaskCreateRequest,
    response: Response,
    admin_id: UUID = Depends(require_admin_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(
        rate_limit("studio_tasks_write", default_max=60, default_window=60.0, actor_dependency=require_admin_id)
    ),
) -> GlobalTaskActionResponse:
    """Create a durable idempotent studio job strictly inside the Admin portal."""
    _apply_no_store(response)
    result = await GlobalTasksService(db).create_task(
        actor_id=admin_id,
        payload=payload,
        portal="admin",
    )
    if result.deduplicated:
        response.status_code = status.HTTP_200_OK
    return result


@router.get("/admin/tasks/{job_id}", response_model=GlobalTaskItem)
async def get_admin_global_task(
    job_id: UUID,
    response: Response,
    admin_id: UUID = Depends(require_admin_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(
        rate_limit("studio_tasks_read", default_max=180, default_window=60.0, actor_dependency=require_admin_id)
    ),
) -> GlobalTaskItem:
    """Fetch a single task strictly owned by the authenticated Admin actor."""
    _apply_no_store(response)
    return await GlobalTasksService(db).get_task(
        actor_id=admin_id,
        job_id=job_id,
        portal="admin",
    )


@router.post("/admin/tasks/{job_id}/retry", response_model=GlobalTaskActionResponse)
async def retry_admin_global_task(
    job_id: UUID,
    response: Response,
    admin_id: UUID = Depends(require_admin_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(
        rate_limit("studio_tasks_write", default_max=60, default_window=60.0, actor_dependency=require_admin_id)
    ),
) -> GlobalTaskActionResponse:
    """Ownership-verified Admin task retry resuming from persisted checkpoints."""
    _apply_no_store(response)
    return await GlobalTasksService(db).retry_task(
        actor_id=admin_id,
        job_id=job_id,
        portal="admin",
    )


@router.post("/admin/tasks/{job_id}/cancel", response_model=GlobalTaskActionResponse)
async def cancel_admin_global_task(
    job_id: UUID,
    response: Response,
    admin_id: UUID = Depends(require_admin_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(
        rate_limit("studio_tasks_write", default_max=60, default_window=60.0, actor_dependency=require_admin_id)
    ),
) -> GlobalTaskActionResponse:
    """Ownership-verified Admin task cancellation (`CANCELLED` or `CANCEL_REQUESTED`)."""
    _apply_no_store(response)
    return await GlobalTasksService(db).cancel_task(
        actor_id=admin_id,
        job_id=job_id,
        portal="admin",
    )


# ---------------------------------------------------------------------------
# Dedicated Parent Portal AI Task Routes (/studio/parent/tasks*)
# ---------------------------------------------------------------------------


@router.get("/parent/tasks", response_model=GlobalTaskListResponse)
async def list_parent_global_tasks(
    response: Response,
    limit: int = Query(default=40, ge=1, le=100),
    active_only: bool = Query(default=False),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_tasks_read", default_max=180, default_window=60.0)),
) -> GlobalTaskListResponse:
    """List tasks strictly scoped to the authenticated Parent actor and Parent portal."""
    _apply_no_store(response)
    return await GlobalTasksService(db).list_tasks(
        actor_id=actor_id,
        limit=_unwrap_limit(limit),
        active_only=_unwrap_bool(active_only),
        portal="parent",
    )


@router.post(
    "/parent/tasks",
    response_model=GlobalTaskActionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_parent_global_task(
    payload: GlobalTaskCreateRequest,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_tasks_write", default_max=60, default_window=60.0)),
) -> GlobalTaskActionResponse:
    """Create a durable idempotent studio job strictly inside the Parent portal."""
    _apply_no_store(response)
    result = await GlobalTasksService(db).create_task(
        actor_id=actor_id,
        payload=payload,
        portal="parent",
    )
    if result.deduplicated:
        response.status_code = status.HTTP_200_OK
    return result


@router.get("/parent/tasks/{job_id}", response_model=GlobalTaskItem)
async def get_parent_global_task(
    job_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_tasks_read", default_max=180, default_window=60.0)),
) -> GlobalTaskItem:
    """Fetch a single task strictly owned by the authenticated Parent actor."""
    _apply_no_store(response)
    return await GlobalTasksService(db).get_task(
        actor_id=actor_id,
        job_id=job_id,
        portal="parent",
    )


@router.post("/parent/tasks/{job_id}/retry", response_model=GlobalTaskActionResponse)
async def retry_parent_global_task(
    job_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_tasks_write", default_max=60, default_window=60.0)),
) -> GlobalTaskActionResponse:
    """Ownership-verified Parent task retry resuming from persisted checkpoints."""
    _apply_no_store(response)
    return await GlobalTasksService(db).retry_task(
        actor_id=actor_id,
        job_id=job_id,
        portal="parent",
    )


@router.post("/parent/tasks/{job_id}/cancel", response_model=GlobalTaskActionResponse)
async def cancel_parent_global_task(
    job_id: UUID,
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_tasks_write", default_max=60, default_window=60.0)),
) -> GlobalTaskActionResponse:
    """Ownership-verified Parent task cancellation (`CANCELLED` or `CANCEL_REQUESTED`)."""
    _apply_no_store(response)
    return await GlobalTasksService(db).cancel_task(
        actor_id=actor_id,
        job_id=job_id,
        portal="parent",
    )


# ---------------------------------------------------------------------------
# Backwards-Compatible Unified Routes (/studio/tasks* with optional ?portal=)
# ---------------------------------------------------------------------------


@router.get("/tasks", response_model=GlobalTaskListResponse)
async def list_global_tasks(
    response: Response,
    limit: int = Query(default=40, ge=1, le=100),
    active_only: bool = Query(default=False),
    portal: ActorRole | None = Query(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_tasks_read", default_max=180, default_window=60.0)),
) -> GlobalTaskListResponse:
    """List actor-scoped durable studio tasks & active background workflows."""
    _apply_no_store(response)
    return await GlobalTasksService(db).list_tasks(
        actor_id=actor_id,
        limit=_unwrap_limit(limit),
        active_only=_unwrap_bool(active_only),
        portal=_unwrap_portal(portal),
    )


@router.post(
    "/tasks",
    response_model=GlobalTaskActionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_global_task(
    payload: GlobalTaskCreateRequest,
    response: Response,
    portal: ActorRole | None = Query(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_tasks_write", default_max=60, default_window=60.0)),
) -> GlobalTaskActionResponse:
    """Create a durable idempotent studio job deduplicated on `(actor_id, idempotency_key)`."""
    _apply_no_store(response)
    result = await GlobalTasksService(db).create_task(
        actor_id=actor_id,
        payload=payload,
        portal=_unwrap_portal(portal),
    )
    if result.deduplicated:
        response.status_code = status.HTTP_200_OK
    return result


@router.post("/tasks/reconcile", response_model=ReconcileTasksResponse)
async def reconcile_global_tasks(
    response: Response,
    _admin_id: UUID = Depends(require_admin_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(
        rate_limit("studio_tasks_write", default_max=60, default_window=60.0, actor_dependency=require_admin_id)
    ),
) -> ReconcileTasksResponse:
    """Admin-only manual trigger for expired-lease reclamation, revision fencing, and R-01 healing."""
    _apply_no_store(response)
    return await GlobalTasksService(db).reconcile_stale_jobs()


@router.get("/tasks/{job_id}", response_model=GlobalTaskItem)
async def get_global_task(
    job_id: UUID,
    response: Response,
    portal: ActorRole | None = Query(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_tasks_read", default_max=180, default_window=60.0)),
) -> GlobalTaskItem:
    """Ownership-verified single-task detail strictly scoped to `(actor_id, portal)`."""
    _apply_no_store(response)
    return await GlobalTasksService(db).get_task(
        actor_id=actor_id,
        job_id=job_id,
        portal=_unwrap_portal(portal),
    )


@router.post("/tasks/{job_id}/retry", response_model=GlobalTaskActionResponse)
async def retry_global_task(
    job_id: UUID,
    response: Response,
    portal: ActorRole | None = Query(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_tasks_write", default_max=60, default_window=60.0)),
) -> GlobalTaskActionResponse:
    """Ownership-verified retry resuming from persisted checkpoints."""
    _apply_no_store(response)
    return await GlobalTasksService(db).retry_task(
        actor_id=actor_id,
        job_id=job_id,
        portal=_unwrap_portal(portal),
    )


@router.post("/tasks/{job_id}/cancel", response_model=GlobalTaskActionResponse)
async def cancel_global_task(
    job_id: UUID,
    response: Response,
    portal: ActorRole | None = Query(default=None),
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_tasks_write", default_max=60, default_window=60.0)),
) -> GlobalTaskActionResponse:
    """Ownership-verified cooperative cancellation (`CANCELLED` or `CANCEL_REQUESTED`)."""
    _apply_no_store(response)
    return await GlobalTasksService(db).cancel_task(
        actor_id=actor_id,
        job_id=job_id,
        portal=_unwrap_portal(portal),
    )


@router.get("/capabilities", response_model=CapabilitiesHealthResponse)
async def get_studio_capabilities(
    response: Response,
    actor_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
    _rate_limited: None = Depends(rate_limit("studio_tasks_read", default_max=180, default_window=60.0)),
) -> CapabilitiesHealthResponse:
    """Real-time AI provider capability matrix & circuit-breaker health (zero secrets)."""
    _apply_no_store(response)
    return await GlobalTasksService(db).get_capabilities(actor_id=actor_id)
