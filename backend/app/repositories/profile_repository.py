"""Repository for the authenticated user's profile and linked child summaries."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import Profile


class ProfileRepository:
    """Read profile rows from PostgreSQL using the existing ORM mappings."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_by_id(self, profile_id: UUID) -> Profile | None:
        result = await self.db.execute(
            select(Profile)
            .where(Profile.Id == profile_id)
            .options(selectinload(Profile.children))
        )
        return result.scalar_one_or_none()
