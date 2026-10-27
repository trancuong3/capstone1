from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.repositories.reading_management_repository import ReadingManagementRepository
from app.services.reading_management_service import ReadingManagementService, ManagementNotFound, ManagementForbidden, ManagementConflict
from app.schemas.reading_management import (
    ReadingGoalCreate, ReadingGoalUpdate, ReadingGoalTransition, ReadingGoalRead,
    ChildBookCollectionCreate, ChildBookCollectionRead, CollectionType, DeletedResponse,
    ReadingReminderCreate, ReadingReminderUpdate, ReadingReminderRead, ReadingReminderOccurrenceRead,
)

router = APIRouter()


def build_service(db: AsyncSession) -> ReadingManagementService:
    return ReadingManagementService(ReadingManagementRepository(db))


def map_domain_error(exc: Exception) -> HTTPException:
    if isinstance(exc, ManagementForbidden):
        return HTTPException(status_code=403, detail="Parent access required")
    if isinstance(exc, ManagementNotFound):
        return HTTPException(status_code=404, detail="Resource not found")
    if isinstance(exc, ManagementConflict):
        return HTTPException(status_code=409, detail="The requested state transition is not allowed")
    return HTTPException(status_code=500, detail="Internal server error")


@router.get("/goals", response_model=list[ReadingGoalRead])
async def list_goals(child_id: UUID = Query(...), actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    try:
        return await build_service(db).list_goals(actor_id, child_id)
    except (ManagementForbidden, ManagementNotFound, ManagementConflict) as exc:
        raise map_domain_error(exc) from None


@router.post("/goals", response_model=ReadingGoalRead, status_code=status.HTTP_201_CREATED)
async def create_goal(payload: ReadingGoalCreate, actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    try:
        management_service = build_service(db)
        row = await management_service.create_goal(actor_id, payload)
        return next(item for item in await management_service.list_goals(actor_id, row.ChildId) if item["id"] == row.Id)
    except (ManagementForbidden, ManagementNotFound, ManagementConflict) as exc:
        raise map_domain_error(exc) from None


@router.patch("/goals/{goal_id}", response_model=ReadingGoalRead)
async def update_goal(goal_id: UUID, payload: ReadingGoalUpdate, actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    try:
        service = build_service(db)
        row = await service.update_goal(actor_id, goal_id, payload)
        return next(item for item in await service.list_goals(actor_id, row.ChildId) if item["id"] == goal_id)
    except (ManagementForbidden, ManagementNotFound, ManagementConflict) as exc:
        raise map_domain_error(exc) from None


@router.post("/goals/{goal_id}/transition", response_model=ReadingGoalRead)
async def transition_goal(goal_id: UUID, payload: ReadingGoalTransition, actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    try:
        service = build_service(db)
        row = await service.transition_goal(actor_id, goal_id, payload)
        return next(item for item in await service.list_goals(actor_id, row.ChildId) if item["id"] == goal_id)
    except (ManagementForbidden, ManagementNotFound, ManagementConflict) as exc:
        raise map_domain_error(exc) from None


@router.get("/collections", response_model=list[ChildBookCollectionRead])
async def list_collections(child_id: UUID = Query(...), actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    try:
        return await build_service(db).list_collections(actor_id, child_id)
    except (ManagementForbidden, ManagementNotFound, ManagementConflict) as exc:
        raise map_domain_error(exc) from None


@router.put("/collections/{book_id}", response_model=ChildBookCollectionRead)
async def add_collection(book_id: UUID, payload: ChildBookCollectionCreate, actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    try:
        service = build_service(db)
        await service.add_collection(actor_id, book_id, payload)
        return next(item for item in await service.list_collections(actor_id, payload.child_id)
                    if item["book_id"] == book_id and item["collection_type"] == payload.collection_type)
    except (ManagementForbidden, ManagementNotFound, ManagementConflict) as exc:
        raise map_domain_error(exc) from None


@router.delete("/collections/{book_id}", response_model=DeletedResponse)
async def remove_collection(book_id: UUID, child_id: UUID = Query(...), collection_type: CollectionType = Query(...),
                            actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    try:
        await build_service(db).remove_collection(actor_id, child_id, book_id, collection_type)
        return {"deleted": True}
    except (ManagementForbidden, ManagementNotFound, ManagementConflict) as exc:
        raise map_domain_error(exc) from None


@router.get("/reminders", response_model=list[ReadingReminderRead])
async def list_reminders(child_id: UUID = Query(...), actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    try:
        return await build_service(db).list_reminders(actor_id, child_id)
    except (ManagementForbidden, ManagementNotFound, ManagementConflict) as exc:
        raise map_domain_error(exc) from None


@router.post("/reminders", response_model=ReadingReminderRead, status_code=status.HTTP_201_CREATED)
async def create_reminder(payload: ReadingReminderCreate, actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    try:
        return await build_service(db).create_reminder(actor_id, payload)
    except (ManagementForbidden, ManagementNotFound, ManagementConflict) as exc:
        raise map_domain_error(exc) from None


@router.patch("/reminders/{reminder_id}", response_model=ReadingReminderRead)
async def update_reminder(reminder_id: UUID, payload: ReadingReminderUpdate, actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    try:
        return await build_service(db).update_reminder(actor_id, reminder_id, payload)
    except (ManagementForbidden, ManagementNotFound, ManagementConflict) as exc:
        raise map_domain_error(exc) from None


@router.delete("/reminders/{reminder_id}", response_model=DeletedResponse)
async def delete_reminder(reminder_id: UUID, actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    try:
        await build_service(db).delete_reminder(actor_id, reminder_id)
        return {"deleted": True}
    except (ManagementForbidden, ManagementNotFound, ManagementConflict) as exc:
        raise map_domain_error(exc) from None


@router.get("/reminders/due", response_model=list[ReadingReminderOccurrenceRead])
async def due_reminders(child_id: UUID = Query(...), actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    try:
        return await build_service(db).due_reminders(actor_id, child_id)
    except (ManagementForbidden, ManagementNotFound, ManagementConflict) as exc:
        raise map_domain_error(exc) from None


@router.post("/reminders/occurrences/{occurrence_id}/acknowledge", response_model=ReadingReminderOccurrenceRead)
async def acknowledge_occurrence(occurrence_id: UUID, actor_id: UUID = Depends(get_current_parent_id), db: AsyncSession = Depends(get_db)):
    try:
        return await build_service(db).acknowledge_occurrence(actor_id, occurrence_id)
    except (ManagementForbidden, ManagementNotFound, ManagementConflict) as exc:
        raise map_domain_error(exc) from None
