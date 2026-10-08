from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from typing import List
from uuid import UUID

from app.api.deps import get_db, get_current_parent_id
from app.models import Profile, ChildProfile
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