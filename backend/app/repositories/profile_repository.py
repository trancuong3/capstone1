"""Repository for the authenticated user's profile and linked child summaries."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import Profile


class ProfileRepository:
    """Read and persist profile rows through PostgreSQL ORM mappings."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_by_id(self, profile_id: UUID) -> Profile | None:
        result = await self.db.execute(
            select(Profile)
            .where(Profile.Id == profile_id)
            .options(selectinload(Profile.children))
        )
        return result.scalar_one_or_none()

    async def get_role(self, profile_id: UUID) -> str | None:
        """Return an actor's persisted application role for authorization."""
        return await self.db.scalar(
            select(Profile.Role).where(Profile.Id == profile_id)
        )

    async def list_all_profiles(self) -> list[Profile]:
        """List profiles with children; the service restricts this to Admin users."""
        result = await self.db.execute(
            select(Profile).options(selectinload(Profile.children))
        )
        return result.scalars().unique().all()

    async def create_profile(
        self,
        role: str,
        display_name: str | None,
    ) -> Profile:
        profile = Profile(Role=role, DisplayName=display_name)
        self.db.add(profile)
        await self.db.commit()
        return await self.get_by_id(profile.Id)  # type: ignore[return-value]

    async def update_display_name(
        self,
        profile_id: UUID,
        display_name: str,
    ) -> Profile | None:
        profile = await self.get_by_id(profile_id)
        if profile is None:
            return None

        profile.DisplayName = display_name
        await self.db.commit()
        return await self.get_by_id(profile_id)

    async def delete_by_id(self, profile_id: UUID) -> bool:
        profile = await self.get_by_id(profile_id)
        if profile is None:
            return False

        await self.db.delete(profile)
        await self.db.commit()
        return True
