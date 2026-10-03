from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from typing import List
from uuid import UUID

from app.api.deps import get_db
from app.models import Profile, ChildProfile
from app.schemas import ProfileResponse, ProfileCreate, ChildProfileResponse, ChildProfileCreate

router = APIRouter()

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