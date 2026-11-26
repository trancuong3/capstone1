"""Repository for the authenticated user's profile and linked child summaries."""

from typing import Sequence
from uuid import UUID

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database.role_cache import get_cached_profile_role, invalidate_cached_role
from app.models import Book, ChildProfile, Profile, ReadingSession


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
        return await get_cached_profile_role(self.db, profile_id)

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
        invalidate_cached_role(profile.Id)
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

    async def update_contact_phone(
        self,
        profile_id: UUID,
        contact_phone: str | None,
    ) -> Profile | None:
        """Persist the parent's unverified contact number, never Auth phone."""
        profile = await self.get_by_id(profile_id)
        if profile is None:
            return None

        profile.ContactPhone = contact_phone
        await self.db.commit()
        return await self.get_by_id(profile_id)

    async def update_avatar_path(
        self,
        profile_id: UUID,
        avatar_path: str | None,
    ) -> Profile | None:
        profile = await self.get_by_id(profile_id)
        if profile is None:
            return None

        profile.AvatarPath = avatar_path
        try:
            await self.db.commit()
        except Exception:
            await self.db.rollback()
            raise
        return profile

    async def get_latest_sessions_by_child_ids(
        self,
        parent_id: UUID,
        child_ids: Sequence[UUID],
    ) -> list[tuple[ReadingSession, str]]:
        """Return each owned child's latest ReadingSession paired with Book.Title in 1 query."""
        ids = list(dict.fromkeys(child_ids))
        if not ids:
            return []
        ranked = (
            select(
                ReadingSession.Id.label("session_id"),
                func.row_number()
                .over(
                    partition_by=ReadingSession.ChildId,
                    order_by=(
                        ReadingSession.StartedAt.desc(),
                        ReadingSession.Id.desc(),
                    ),
                )
                .label("rn"),
            )
            .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
            .where(
                ChildProfile.ParentId == parent_id,
                ReadingSession.ChildId.in_(ids),
            )
            .subquery()
        )
        result = await self.db.execute(
            select(ReadingSession, Book.Title)
            .join(ranked, ranked.c.session_id == ReadingSession.Id)
            .join(Book, Book.Id == ReadingSession.BookId)
            .where(ranked.c.rn == 1)
        )
        return [(session, str(book_title or "")) for session, book_title in result.all()]

    async def get_dashboard_summary_rows(
        self,
        parent_id: UUID,
    ) -> list[tuple[Profile, ChildProfile | None, ReadingSession | None, str | None]]:
        """Return profile, owned children, and each child's latest session + book title in 1 SQL query."""
        ranked = (
            select(
                ReadingSession.Id.label("session_id"),
                ReadingSession.ChildId.label("child_id"),
                func.row_number()
                .over(
                    partition_by=ReadingSession.ChildId,
                    order_by=(
                        ReadingSession.StartedAt.desc(),
                        ReadingSession.Id.desc(),
                    ),
                )
                .label("rn"),
            )
            .join(ChildProfile, ChildProfile.Id == ReadingSession.ChildId)
            .where(ChildProfile.ParentId == parent_id)
            .subquery()
        )
        stmt = (
            select(Profile, ChildProfile, ReadingSession, Book.Title)
            .outerjoin(ChildProfile, ChildProfile.ParentId == Profile.Id)
            .outerjoin(
                ranked,
                and_(
                    ranked.c.child_id == ChildProfile.Id,
                    ranked.c.rn == 1,
                ),
            )
            .outerjoin(ReadingSession, ReadingSession.Id == ranked.c.session_id)
            .outerjoin(Book, Book.Id == ReadingSession.BookId)
            .where(Profile.Id == parent_id)
            .order_by(ChildProfile.CreatedAt.desc(), ChildProfile.Id.desc())
        )
        result = await self.db.execute(stmt)
        return [
            (
                profile,
                child,
                session,
                str(book_title) if book_title is not None else None,
            )
            for profile, child, session, book_title in result.all()
        ]

    async def delete_by_id(self, profile_id: UUID) -> bool:
        profile = await self.get_by_id(profile_id)
        if profile is None:
            return False

        await self.db.delete(profile)
        await self.db.commit()
        invalidate_cached_role(profile_id)
        return True