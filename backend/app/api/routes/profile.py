from fastapi import APIRouter, Depends, HTTPException, status, Response
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
    ChildProfileResponse,
    ChildProfileCreate,
    ChildProfileUpdate,
    ProfileUpdate,
)


# ==========================================
# CHILD PROFILE ERRORS
# ==========================================

class ChildProfileNotFoundError(Exception):
    """
    Child profile không tồn tại hoặc không thuộc
    parent hiện tại.
    """

    pass


# ==========================================
# CHILD PROFILE REPOSITORY
# ==========================================

class ChildProfileRepository:
    """
    Repository chịu trách nhiệm truy cập Database
    cho Child Profile.

    Không chứa business logic.
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    async def list_by_parent(
        self,
        parent_id: UUID,
    ):
        """
        Lấy tất cả child profile thuộc parent.
        """

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
        """
        Lấy một child profile đồng thời kiểm tra ownership
        thông qua child_id + parent_id.
        """

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
        """
        INSERT child profile vào Database.
        """

        self.db.add(child)

        await self.db.commit()
        await self.db.refresh(child)

        return child

    async def update(
        self,
        child: ChildProfile,
    ):
        """
        Lưu thay đổi Child Profile.
        """

        await self.db.commit()
        await self.db.refresh(child)

        return child

    async def delete(
        self,
        child: ChildProfile,
    ):
        """
        Xóa Child Profile khỏi Database.
        """

        await self.db.delete(child)
        await self.db.commit()


# ==========================================
# CHILD PROFILE SERVICE
# ==========================================

class ChildProfileService:
    """
    Service xử lý business logic cho Child Profile.

    Service không thao tác Database trực tiếp.
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
        """
        Lấy danh sách child của parent hiện tại.
        """

        return await self.repository.list_by_parent(
            parent_id
        )

    async def create_child(
        self,
        parent_id: UUID,
        child_in: ChildProfileCreate,
    ):
        """
        Tạo Child Profile.

        parent_id được lấy từ authenticated user,
        không lấy từ request body.
        """

        child = ChildProfile(
            ParentId=parent_id,
            Alias=child_in.alias,
            Grade=child_in.grade,
            Settings=child_in.settings,
        )

        return await self.repository.create(child)

    async def get_child(
        self,
        child_id: UUID,
        parent_id: UUID,
    ):
        """
        Lấy Child Profile thuộc parent hiện tại.
        """

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
        """
        Update alias và grade của Child Profile.
        """

        child = await self.repository.get_by_id_and_parent(
            child_id,
            parent_id,
        )

        if child is None:
            raise ChildProfileNotFoundError()

        child.Alias = data.alias
        child.Grade = data.grade

        return await self.repository.update(child)

    async def delete_child(
        self,
        child_id: UUID,
        parent_id: UUID,
    ):
        """
        Delete Child Profile thuộc parent hiện tại.
        """

        child = await self.repository.get_by_id_and_parent(
            child_id,
            parent_id,
        )

        if child is None:
            raise ChildProfileNotFoundError()

        await self.repository.delete(child)


# ==========================================
# ROUTER
# ==========================================

router = APIRouter()


# ==========================================
# CÁC API CHO CÁC BÉ
# ==========================================

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
    Lấy danh sách Child Profile của
    authenticated parent.
    """

    repository = ChildProfileRepository(db)
    service = ChildProfileService(repository)

    return await service.list_children(
        current_parent_id
    )


@router.post(
    "/children",
    response_model=ChildProfileResponse,
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

    parent_id không được lấy từ request body.
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
    Lấy Child Profile.

    Chỉ cho phép truy cập Child Profile
    thuộc authenticated parent.
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
    data: ChildProfileUpdate,
    db: AsyncSession = Depends(get_db),
    current_parent_id: UUID = Depends(
        get_current_parent_id
    ),
):
    """
    Cập nhật Child Profile.

    Chỉ cho phép sửa Child Profile
    thuộc authenticated parent.
    """

    repository = ChildProfileRepository(db)
    service = ChildProfileService(repository)

    try:
        return await service.update_child(
            child_id,
            current_parent_id,
            data,
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
    Xóa Child Profile.

    Chỉ cho phép xóa Child Profile
    thuộc authenticated parent.
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

    return Response(
        status_code=status.HTTP_204_NO_CONTENT
    )


# ==========================================
# CÁC API CHO PHỤ HUYNH
# ==========================================

@router.get(
    "/",
    response_model=List[ProfileResponse],
)
async def get_profiles(
    db: AsyncSession = Depends(get_db),
):
    """
    Lấy danh sách tất cả Phụ huynh
    kèm theo hồ sơ các bé.
    """

    query = (
        select(Profile)
        .options(
            selectinload(Profile.children)
        )
    )

    result = await db.execute(query)

    return result.scalars().unique().all()


@router.post(
    "/",
    response_model=ProfileResponse,
)
async def create_profile(
    profile_in: ProfileCreate,
    db: AsyncSession = Depends(get_db),
):
    """
    Tạo mới một hồ sơ Phụ huynh.
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


# ==========================================
# GET PROFILE BY ID
# ==========================================

@router.get(
    "/{profile_id}",
    response_model=ProfileResponse,
)
async def get_profile(
    profile_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """
    Lấy Hồ sơ phụ huynh theo ID.
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


# ==========================================
# UPDATE PROFILE
# ==========================================

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
    Cập nhật Hồ sơ phụ huynh.
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

    profile.DisplayName = profile_in.DisplayName

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


# ==========================================
# DELETE PROFILE
# ==========================================

@router.delete(
    "/{profile_id}"
)
async def delete_profile(
    profile_id: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Xóa Hồ sơ phụ huynh.
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