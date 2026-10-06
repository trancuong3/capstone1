from fastapi import APIRouter, Depends, HTTPException, status, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from typing import List
from uuid import UUID

from app.api.deps import get_db
from app.models import Profile, ChildProfile
from app.schemas import (
    ProfileResponse,
    ProfileCreate,
    ChildProfileResponse,
    ChildProfileCreate,
    ChildProfileUpdate,
    ProfileUpdate
)
router = APIRouter()




# ==========================================
# CÁC API CHO CÁC BÉ
# ==========================================

@router.get("/children", response_model=List[ChildProfileResponse])
async def get_all_children(db: AsyncSession = Depends(get_db)):
    """Lấy danh sách toàn bộ học sinh/các bé"""
    result = await db.execute(select(ChildProfile))
    return result.scalars().all()

@router.post("/children", response_model=ChildProfileResponse)
async def create_child(child_in: ChildProfileCreate, db: AsyncSession = Depends(get_db)):
    """Tạo mới một hồ sơ bé (Cần truyền ParentId)"""
    new_child = ChildProfile(**child_in.model_dump())
    db.add(new_child)
    await db.commit()
    await db.refresh(new_child)
    return new_child

@router.get("/children/{child_id}", response_model=ChildProfileResponse)
async def get_child(
    child_id: UUID,
    db: AsyncSession = Depends(get_db)
):
    """Lấy hồ sơ bé theo ID"""

    query = (
        select(ChildProfile)
        .where(ChildProfile.Id == child_id)
    )

    result = await db.execute(query)
    child = result.scalar_one_or_none()

    if not child:
        raise HTTPException(
            status_code=404,
            detail="Child profile not found"
        )

    return child

"""Cập nhật hồ sơ bé theo ID"""
@router.put("/children/{child_id}", response_model=ChildProfileResponse)
async def update_child(
    child_id: UUID,
    data: ChildProfileUpdate,
    db: AsyncSession = Depends(get_db)
):
    # Tìm child
    result = await db.execute(
        select(ChildProfile)
        .where(ChildProfile.Id == child_id)
    )

    child = result.scalar_one_or_none()

    if not child:
        raise HTTPException(
            status_code=404,
            detail="Child profile not found"
        )

    # Update dữ liệu
    child.Alias = data.alias
    child.Grade = data.grade


    # Lưu database
    await db.commit()

    # Query lại để lấy dữ liệu mới
    result = await db.execute(
        select(ChildProfile)
        .where(ChildProfile.Id == child_id)
    )

    child = result.scalar_one()

    return child


@router.delete(
    "/children/{child_id}",
    status_code=status.HTTP_204_NO_CONTENT
)
async def delete_child(
    child_id: UUID,
    db: AsyncSession = Depends(get_db)
):
    """Xóa hồ sơ bé theo ID"""

    query = (
        select(ChildProfile)
        .where(ChildProfile.Id == child_id)
    )

    result = await db.execute(query)
    child = result.scalar_one_or_none()

    if not child:
        raise HTTPException(
            status_code=404,
            detail="Child profile not found"
        )

    await db.delete(child)
    await db.commit()

    return Response(status_code=status.HTTP_204_NO_CONTENT)






# ==========================================
# CÁC API CHO PHỤ HUYNH
# ==========================================

@router.get("/", response_model=List[ProfileResponse])
async def get_profiles(db: AsyncSession = Depends(get_db)):
    """Lấy danh sách tất cả Phụ huynh kèm theo hồ sơ các bé"""
    # selectinload giúp kéo dữ liệu từ bảng ChildProfiles đính kèm vào Profile
    query = select(Profile).options(selectinload(Profile.children))
    result = await db.execute(query)
    return result.scalars().unique().all()

@router.post("/", response_model=ProfileResponse)
async def create_profile(profile_in: ProfileCreate, db: AsyncSession = Depends(get_db)):
    """Tạo mới một hồ sơ Phụ huynh"""
    new_profile = Profile(**profile_in.model_dump())
    db.add(new_profile)
    await db.commit()
    query = select(Profile).where(Profile.Id == new_profile.Id).options(selectinload(Profile.children))
    result = await db.execute(query)
    return result.scalar_one()

"""Lấy Hồ sơ phụ huynh theo ID"""
@router.get("/{profile_id}", response_model=ProfileResponse)
async def get_profile(
    profile_id: UUID,
    db: AsyncSession = Depends(get_db)
):
    query = (
        select(Profile)
        .where(Profile.Id == profile_id)
        .options(selectinload(Profile.children))
    )

    result = await db.execute(query)

    profile = result.scalar_one_or_none()

    if not profile:
        raise HTTPException(
            status_code=404,
            detail="Profile not found"
        )

    return profile

"""Cập nhật Hồ sơ phụ huynh theo ID"""
@router.put("/{profile_id}", response_model=ProfileResponse)
async def update_profile(
    profile_id: UUID,
    profile_in: ProfileUpdate,
    db: AsyncSession = Depends(get_db)
):
    # 1. Tìm profile
    result = await db.execute(
        select(Profile)
        .where(Profile.Id == profile_id)
    )

    profile = result.scalar_one_or_none()

    if not profile:
        raise HTTPException(
            status_code=404,
            detail="Profile not found"
        )

    # 2. Update
    profile.DisplayName = profile_in.DisplayName

    # 3. Save
    await db.commit()

    # 4. Query lại và load children
    result = await db.execute(
        select(Profile)
        .where(Profile.Id == profile_id)
        .options(selectinload(Profile.children))
    )

    profile = result.scalar_one()

    # 5. Trả về
    return profile

"""Xóa Hồ sơ phụ huynh theo ID"""

@router.delete("/{profile_id}")
async def delete_profile(
    profile_id: str,
    db: AsyncSession = Depends(get_db)
):
    result = await db.execute(
        select(Profile)
        .where(Profile.Id == profile_id)
    )

    profile = result.scalar_one_or_none()

    if not profile:
        raise HTTPException(
            status_code=404,
            detail="Profile not found"
        )

    await db.delete(profile)
    await db.commit()

    return {
        "message": "Profile deleted"
    }
