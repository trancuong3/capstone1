"""Database queries for the Admin Parent directory and detail views."""
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ChildProfile, Profile


class AdminParentRepository:
    """Read-only PostgreSQL access for Admin parent queries."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, actor_id: UUID) -> str | None:
        """Return the persisted role of an authenticated actor."""
        return await self.db.scalar(
            select(Profile.Role).where(Profile.Id == actor_id)
        )

    async def get_parent_detail(self, parent_id: UUID) -> dict[str, Any] | None:
        """Return a safe projection of a parent and only its linked children."""
        result = await self.db.execute(
            select(Profile).where(
                Profile.Id == parent_id,
                Profile.Role == "parent",
            )
        )
        parent = result.scalar_one_or_none()
        if parent is None:
            return None

        child_result = await self.db.execute(
            select(ChildProfile)
            .where(ChildProfile.ParentId == parent_id)
            .order_by(ChildProfile.CreatedAt.desc(), ChildProfile.Id.asc())
        )
        children = [
            {
                "id": child.Id,
                "alias": child.Alias,
                "grade": child.Grade,
                "created_at": child.CreatedAt,
            }
            for child in child_result.scalars().all()
        ]

        return {
            "id": parent.Id,
            "display_name": parent.DisplayName,
            "created_at": parent.CreatedAt,
            "children": children,
        }

    async def list_parent_rows(
        self,
        search: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        """Return matching parent rows and the unpaginated total."""
        filters = [Profile.Role == "parent"]
        if search and search.strip():
            # Escape LIKE wildcards so search is treated as literal user input.
            term = (
                search.strip()
                .replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_")
            )
            filters.append(
                Profile.DisplayName.ilike(f"%{term}%", escape="\\")
            )

        total = await self.db.scalar(
            select(func.count(Profile.Id)).where(*filters)
        )

        query = (
            select(
                Profile.Id.label("id"),
                Profile.DisplayName.label("display_name"),
                Profile.CreatedAt.label("created_at"),
                func.count(ChildProfile.Id).label("children_count"),
            )
            .outerjoin(ChildProfile, ChildProfile.ParentId == Profile.Id)
            .where(*filters)
            .group_by(Profile.Id, Profile.DisplayName, Profile.CreatedAt)
            .order_by(Profile.CreatedAt.desc(), Profile.Id.asc())
            .offset(offset)
            .limit(limit)
        )
        result = await self.db.execute(query)
        items = [
            {
                "id": row.id,
                "display_name": row.display_name,
                "created_at": row.created_at,
                "children_count": row.children_count,
            }
            for row in result.all()
        ]
        return items, int(total or 0)
