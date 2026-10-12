from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload
from typing import List, Literal
from uuid import UUID

from app.api.deps import get_db, get_current_parent_id
from app.models import Profile, ChildProfile
from app.schemas.profile import (
    AdminParentListResponse,
    AdminParentDetailResponse,
    AdminParentCreateRequest,
    AdminParentUpdateRequest,
    AdminParentVisibilityRequest,
    AdminParentVisibilityResponse,
)
from app.repositories.admin_parent_repository import AdminParentRepository
from app.services.admin_parent_service import (
    AdminParentAccessDeniedError,
    AdminParentNotFoundError,
    AdminParentConflictError,
    AdminParentProviderUnavailableError,
    AdminParentProviderOperationError,
    AdminParentConsistencyError,
    AdminParentService,
)
from app.schemas import (
    ProfileResponse,
    ProfileCreate,
    ParentProfileResponse,
    ChildProfileResponse,
    ChildProfileCreate,
    ChildProfileUpdate,
    ProfileUpdate,
)

# =========================================================
# ERRORS
# =========================================================

class ChildProfileNotFoundError(Exception):
    """
    Child profile không tồn tại hoặc không thuộc
    parent hiện tại.
    """
    pass


class ProfileNotFoundError(Exception):
    """
    Parent profile không tồn tại.
    """
    pass


# =========================================================
# CHILD PROFILE REPOSITORY
# =========================================================

class ChildProfileRepository:
    """
    Repository chịu trách nhiệm truy cập Database
    cho Child Profile.

    Không chứa business logic.
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    async def list_by_parent(self, parent_id: UUID):
        result = await self.db.execute(
            select(ChildProfile)
            .where(
                ChildProfile.ParentId == parent_id
            )
            .order_by(
                ChildProfile.CreatedAt.desc()
            )
        )

        return result.scalars().all()

    async def get_by_id_and_parent(
        self,
        child_id: UUID,
        parent_id: UUID,
    ):
        result = await self.db.execute(
            select(ChildProfile)
            .where(
                ChildProfile.Id == child_id,
                ChildProfile.ParentId == parent_id,
            )
        )

        return result.scalar_one_or_none()

    async def create(
        self,
        child: ChildProfile,
    ):
        self.db.add(child)

        await self.db.commit()
        await self.db.refresh(child)

        return child

    async def update(
        self,
        child: ChildProfile,
    ):
        await self.db.commit()
        await self.db.refresh(child)

        return child

    async def delete(
        self,
        child: ChildProfile,
    ):
        await self.db.delete(child)

        await self.db.commit()


# =========================================================
# CHILD PROFILE SERVICE
# =========================================================

class ChildProfileService:
    """
    Service xử lý business logic cho Child Profile.

    Service không truy cập Database trực tiếp.
    """

    def __init__(
        self,
        repository: ChildProfileRepository,
    ):
        self.repository = repository

    async def list_children(
        self,
        parent_id: UUID,
    ):
        return await self.repository.list_by_parent(
            parent_id
        )

    async def create_child(
        self,
        parent_id: UUID,
        child_in: ChildProfileCreate,
    ):
        child = ChildProfile(
            ParentId=parent_id,
            Alias=child_in.alias,
            Grade=child_in.grade,
            Settings=child_in.settings,
        )

        return await self.repository.create(
            child
        )

    async def get_child(
        self,
        child_id: UUID,
        parent_id: UUID,
    ):
        child = await self.repository.get_by_id_and_parent(
            child_id,
            parent_id,
        )

        if child is None:
            raise ChildProfileNotFoundError()

        return child

    async def update_child(
        self,
        child_id: UUID,
        parent_id: UUID,
        data: ChildProfileUpdate,
    ):
        child = await self.repository.get_by_id_and_parent(
            child_id,
            parent_id,
        )

        if child is None:
            raise ChildProfileNotFoundError()

        child.Alias = data.alias
        child.Grade = data.grade

        return await self.repository.update(
            child
        )

    async def delete_child(
        self,
        child_id: UUID,
        parent_id: UUID,
    ):
        child = await self.repository.get_by_id_and_parent(
            child_id,
            parent_id,
        )

        if child is None:
            raise ChildProfileNotFoundError()

        await self.repository.delete(
            child
        )


# =========================================================
# PARENT PROFILE REPOSITORY
# =========================================================

class ProfileRepository:
    """
    Repository chịu trách nhiệm truy cập Database
    cho Parent Profile.

    Không chứa business logic.
    """

    def __init__(
        self,
        db: AsyncSession,
    ):
        self.db = db

    async def get_by_id(
        self,
        profile_id: UUID,
    ):
        result = await self.db.execute(
            select(Profile)
            .where(
                Profile.Id == profile_id
            )
        )

        return result.scalar_one_or_none()


# =========================================================
# PARENT PROFILE SERVICE
# =========================================================

class ProfileService:
    """
    Service xử lý business logic cho Parent Profile.

    Service không truy cập Database trực tiếp.
    """

    def __init__(
        self,
        repository: ProfileRepository,
    ):
        self.repository = repository

    async def get_current_profile(
        self,
        parent_id: UUID,
    ):
        profile = await self.repository.get_by_id(
            parent_id
        )

        if profile is None:
            raise ProfileNotFoundError()

        return profile


# =========================================================
# ROUTER
# =========================================================

router = APIRouter()


# =========================================================
# CHILD PROFILE APIs
# =========================================================

@router.get(
    "/children",
    response_model=List[ChildProfileResponse],
)
async def get_all_children(
    db: AsyncSession = Depends(get_db),
    current_parent_id: UUID = Depends(
        get_current_parent_id
    ),
):
    """
    Lấy danh sách tất cả child của parent hiện tại.
    """

    repository = ChildProfileRepository(db)
    service = ChildProfileService(repository)

    return await service.list_children(
        current_parent_id
    )


@router.post(
    "/children",
    response_model=ChildProfileResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_child(
    child_in: ChildProfileCreate,
    db: AsyncSession = Depends(get_db),
    current_parent_id: UUID = Depends(
        get_current_parent_id
    ),
):
    """
    Tạo Child Profile cho authenticated parent.
    """

    repository = ChildProfileRepository(db)
    service = ChildProfileService(repository)

    return await service.create_child(
        current_parent_id,
        child_in,
    )


@router.get(
    "/children/{child_id}",
    response_model=ChildProfileResponse,
)
async def get_child(
    child_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_parent_id: UUID = Depends(
        get_current_parent_id
    ),
):
    """
    Lấy một Child Profile thuộc parent hiện tại.
    """

    repository = ChildProfileRepository(db)
    service = ChildProfileService(repository)

    try:
        return await service.get_child(
            child_id,
            current_parent_id,
        )

    except ChildProfileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "RESOURCE_NOT_FOUND",
                "message": "Child profile not found",
            },
        )


@router.put(
    "/children/{child_id}",
    response_model=ChildProfileResponse,
)
async def update_child(
    child_id: UUID,
    child_in: ChildProfileUpdate,
    db: AsyncSession = Depends(get_db),
    current_parent_id: UUID = Depends(
        get_current_parent_id
    ),
):
    """
    Cập nhật Child Profile thuộc parent hiện tại.
    """

    repository = ChildProfileRepository(db)
    service = ChildProfileService(repository)

    try:
        return await service.update_child(
            child_id,
            current_parent_id,
            child_in,
        )

    except ChildProfileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "RESOURCE_NOT_FOUND",
                "message": "Child profile not found",
            },
        )


@router.delete(
    "/children/{child_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_child(
    child_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_parent_id: UUID = Depends(
        get_current_parent_id
    ),
):
    """
    Xóa Child Profile thuộc parent hiện tại.
    """

    repository = ChildProfileRepository(db)
    service = ChildProfileService(repository)

    try:
        await service.delete_child(
            child_id,
            current_parent_id,
        )

    except ChildProfileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "RESOURCE_NOT_FOUND",
                "message": "Child profile not found",
            },
        )


# =========================================================
# PARENT PROFILE APIs
# =========================================================


@router.get(
    "/me",
    response_model=ParentProfileResponse,
)
async def get_current_profile(
    db: AsyncSession = Depends(get_db),
    current_parent_id: UUID = Depends(
        get_current_parent_id
    ),
):
    """
    Lấy Parent Profile của authenticated parent.

    parent_id được lấy từ Supabase access token,
    không lấy từ Frontend request.
    """

    repository = ProfileRepository(db)
    service = ProfileService(repository)

    try:
        profile = await service.get_current_profile(
            current_parent_id
        )

    except ProfileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "RESOURCE_NOT_FOUND",
                "message": "Profile not found",
            },
        )

    return ParentProfileResponse.model_validate(
        profile,
        from_attributes=True,
    )


# =========================================================
# ADMIN: PARENT DIRECTORY AND DETAIL
# =========================================================

@router.get(
    "/admin/parents",
    response_model=AdminParentListResponse,
)
async def get_admin_parent_directory(
    search: str | None = Query(default=None, max_length=100),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    visibility: Literal["visible", "hidden"] = Query(default="visible"),
    admin_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """List parent profiles for authenticated Admin users only."""
    service = AdminParentService(AdminParentRepository(db))
    try:
        result = await service.list_parents(
            admin_id, search, limit, offset, visibility=visibility
        )
    except AdminParentAccessDeniedError as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": "Admin access required"},
        ) from error
    except SQLAlchemyError as error:
        raise _parent_admin_error_response(error) from error

    return AdminParentListResponse(
        items=result.items,
        total=result.total,
        limit=result.limit,
        offset=result.offset,
    )


@router.get(
    "/admin/parents/{parent_id}",
    response_model=AdminParentDetailResponse,
)
async def get_admin_parent_detail(
    parent_id: UUID,
    include_hidden: bool = Query(default=False),
    admin_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Get one Parent and its linked children for authorized Admin users."""
    service = AdminParentService(AdminParentRepository(db))
    try:
        result = await service.get_parent_detail(
            admin_id, parent_id, include_hidden=include_hidden
        )
    except AdminParentAccessDeniedError as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": "Admin access required"},
        ) from error
    except AdminParentNotFoundError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "RESOURCE_NOT_FOUND", "message": "Parent not found"},
        ) from error
    except SQLAlchemyError as error:
        raise _parent_admin_error_response(error) from error

    return AdminParentDetailResponse(
        id=result.id,
        display_name=result.display_name,
        email=result.email,
        phone=result.phone,
        created_at=result.created_at,
        admin_hidden_at=result.admin_hidden_at,
        children=result.children,
        contact_info_status=result.contact_info_status,
    )


# =========================================================
# ADMIN: PARENT CREATE / UPDATE / HIDE / RESTORE
# =========================================================

def _parent_detail_response(result):
    return AdminParentDetailResponse(
        id=result.id,
        display_name=result.display_name,
        email=result.email,
        phone=result.phone,
        created_at=result.created_at,
        admin_hidden_at=result.admin_hidden_at,
        children=result.children,
        contact_info_status=result.contact_info_status,
    )


def _parent_admin_error_response(error: Exception):
    if isinstance(error, SQLAlchemyError):
        return HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "DATABASE_OPERATION_FAILED", "message": "The Parent operation could not be completed"},
        )
    if isinstance(error, AdminParentAccessDeniedError):
        return HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "FORBIDDEN", "message": "Admin access required"},
        )
    if isinstance(error, AdminParentNotFoundError):
        return HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "RESOURCE_NOT_FOUND", "message": "Parent not found"},
        )
    if isinstance(error, AdminParentConflictError):
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "PARENT_CONFLICT", "message": "The requested Parent data conflicts with an existing account"},
        )
    if isinstance(error, AdminParentProviderUnavailableError):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "AUTH_PROVIDER_UNAVAILABLE", "message": "Supabase Auth Admin is not configured"},
        )
    if isinstance(error, (AdminParentProviderOperationError, AdminParentConsistencyError)):
        return HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "PARENT_AUTH_OPERATION_FAILED", "message": "The Parent operation could not be completed consistently"},
        )
    raise error


@router.post(
    "/admin/parents",
    response_model=AdminParentDetailResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_admin_parent(
    parent_in: AdminParentCreateRequest,
    admin_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Invite a Parent through Supabase Auth; the existing Auth trigger creates profiles."""
    service = AdminParentService(AdminParentRepository(db))
    try:
        result = await service.create_parent(
            admin_id,
            display_name=parent_in.display_name,
            email=str(parent_in.email),
            phone=parent_in.phone,
        )
        return _parent_detail_response(result)
    except (
        AdminParentAccessDeniedError,
        AdminParentNotFoundError,
        AdminParentConflictError,
        AdminParentProviderUnavailableError,
        AdminParentProviderOperationError,
        AdminParentConsistencyError,
    ) as error:
        raise _parent_admin_error_response(error) from error
    except SQLAlchemyError as error:
        raise _parent_admin_error_response(error) from error


@router.patch(
    "/admin/parents/{parent_id}",
    response_model=AdminParentDetailResponse,
)
async def update_admin_parent(
    parent_id: UUID,
    parent_in: AdminParentUpdateRequest,
    admin_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Update only allowed Parent fields through their authoritative data stores."""
    service = AdminParentService(AdminParentRepository(db))
    fields = parent_in.model_fields_set
    try:
        result = await service.update_parent(
            admin_id,
            parent_id,
            display_name=parent_in.display_name,
            update_display_name="display_name" in fields,
            email=str(parent_in.email) if parent_in.email is not None else None,
            update_email="email" in fields,
            phone=parent_in.phone,
            update_phone="phone" in fields,
        )
        return _parent_detail_response(result)
    except (
        AdminParentAccessDeniedError,
        AdminParentNotFoundError,
        AdminParentConflictError,
        AdminParentProviderUnavailableError,
        AdminParentProviderOperationError,
        AdminParentConsistencyError,
    ) as error:
        raise _parent_admin_error_response(error) from error
    except SQLAlchemyError as error:
        raise _parent_admin_error_response(error) from error


@router.delete(
    "/admin/parents/{parent_id}",
    response_model=AdminParentVisibilityResponse,
)
async def hide_admin_parent(
    parent_id: UUID,
    admin_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Hide a Parent from the Admin directory by updating its visibility timestamp only."""
    service = AdminParentService(AdminParentRepository(db))
    try:
        result = await service.hide_parent(admin_id, parent_id)
        return AdminParentVisibilityResponse(
            id=result.id,
            is_hidden=result.is_hidden,
            admin_hidden_at=result.admin_hidden_at,
        )
    except (AdminParentAccessDeniedError, AdminParentNotFoundError) as error:
        raise _parent_admin_error_response(error) from error
    except SQLAlchemyError as error:
        raise _parent_admin_error_response(error) from error


@router.patch(
    "/admin/parents/{parent_id}/visibility",
    response_model=AdminParentVisibilityResponse,
)
async def update_admin_parent_visibility(
    parent_id: UUID,
    visibility_in: AdminParentVisibilityRequest,
    admin_id: UUID = Depends(get_current_parent_id),
    db: AsyncSession = Depends(get_db),
):
    """Explicitly hide or restore a Parent without deleting any underlying data."""
    service = AdminParentService(AdminParentRepository(db))
    try:
        result = (
            await service.hide_parent(admin_id, parent_id)
            if visibility_in.is_hidden
            else await service.restore_parent(admin_id, parent_id)
        )
        return AdminParentVisibilityResponse(
            id=result.id,
            is_hidden=result.is_hidden,
            admin_hidden_at=result.admin_hidden_at,
        )
    except (AdminParentAccessDeniedError, AdminParentNotFoundError) as error:
        raise _parent_admin_error_response(error) from error
    except SQLAlchemyError as error:
        raise _parent_admin_error_response(error) from error


# GET ALL PROFILES
# =========================================================

@router.get(
    "/",
    response_model=List[ProfileResponse],
)
async def get_profiles(
    db: AsyncSession = Depends(get_db),
):
    """
    Lấy tất cả Parent Profiles.

    API này giữ nguyên từ implementation hiện tại.
    """

    query = (
        select(Profile)
        .options(
            selectinload(Profile.children)
        )
    )

    result = await db.execute(query)

    return (
        result
        .scalars()
        .unique()
        .all()
    )


# =========================================================
# CREATE PROFILE
# =========================================================

@router.post(
    "/",
    response_model=ProfileResponse,
)
async def create_profile(
    profile_in: ProfileCreate,
    db: AsyncSession = Depends(get_db),
):
    """
    Tạo Parent Profile.

    API này giữ nguyên implementation hiện tại.
    """

    new_profile = Profile(
        **profile_in.model_dump()
    )

    db.add(new_profile)

    await db.commit()

    query = (
        select(Profile)
        .where(
            Profile.Id == new_profile.Id
        )
        .options(
            selectinload(Profile.children)
        )
    )

    result = await db.execute(query)

    return result.scalar_one()


# =========================================================
# GET PROFILE BY ID
# =========================================================

@router.get(
    "/{profile_id}",
    response_model=ProfileResponse,
)
async def get_profile(
    profile_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """
    Lấy Profile theo ID.

    Route /me phải được khai báo phía trên route này.
    """

    query = (
        select(Profile)
        .where(
            Profile.Id == profile_id
        )
        .options(
            selectinload(Profile.children)
        )
    )

    result = await db.execute(query)

    profile = result.scalar_one_or_none()

    if not profile:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Profile not found",
        )

    return profile


# =========================================================
# UPDATE PROFILE
# =========================================================

@router.put(
    "/{profile_id}",
    response_model=ProfileResponse,
)
async def update_profile(
    profile_id: UUID,
    profile_in: ProfileUpdate,
    db: AsyncSession = Depends(get_db),
):
    """
    Cập nhật Parent Profile.
    """

    result = await db.execute(
        select(Profile)
        .where(
            Profile.Id == profile_id
        )
    )

    profile = result.scalar_one_or_none()

    if not profile:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Profile not found",
        )

    profile.DisplayName = profile_in.displayname

    await db.commit()

    result = await db.execute(
        select(Profile)
        .where(
            Profile.Id == profile_id
        )
        .options(
            selectinload(Profile.children)
        )
    )

    profile = result.scalar_one()

    return profile


# =========================================================
# DELETE PROFILE
# =========================================================

@router.delete(
    "/{profile_id}",
)
async def delete_profile(
    profile_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """
    Xóa Parent Profile.
    """

    result = await db.execute(
        select(Profile)
        .where(
            Profile.Id == profile_id
        )
    )

    profile = result.scalar_one_or_none()

    if not profile:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Profile not found",
        )

    await db.delete(profile)

    await db.commit()

    return {
        "message": "Profile deleted"
    }