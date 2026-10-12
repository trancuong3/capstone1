"""PostgreSQL queries for Admin Parent management.

This repository never calls Supabase Auth and queries only established profile fields.
"""
from typing import Any
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ChildProfile, Profile


class AdminParentRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, actor_id: UUID) -> str | None:
        """Return the persisted role of an authenticated actor."""
        return await self.db.scalar(
            select(Profile.Role).where(Profile.Id == actor_id)
        )

    async def get_parent_record(self, parent_id: UUID) -> dict[str, Any] | None:
        """Return only the profile fields supported by the current schema."""
        result = await self.db.execute(
            select(
                Profile.Id.label("id"),
                Profile.DisplayName.label("display_name"),
                Profile.CreatedAt.label("created_at"),
            ).where(
                Profile.Id == parent_id,
                Profile.Role == "parent",
            )
        )
        row = result.one_or_none()
        if row is None:
            return None
        return {
            "id": row.id,
            "display_name": row.display_name,
            "created_at": row.created_at,
        }

    async def get_parent_detail(self, parent_id: UUID) -> dict[str, Any] | None:
        """Return a safe projection of a Parent and only its linked children."""
        result = await self.db.execute(
            select(
                Profile.Id.label("id"),
                Profile.DisplayName.label("display_name"),
                Profile.CreatedAt.label("created_at"),
            ).where(
                Profile.Id == parent_id,
                Profile.Role == "parent",
            )
        )
        parent = result.one_or_none()
        if parent is None:
            return None

        child_result = await self.db.execute(
            select(
                ChildProfile.Id.label("id"),
                ChildProfile.Alias.label("alias"),
                ChildProfile.Grade.label("grade"),
                ChildProfile.CreatedAt.label("created_at"),
            )
            .where(ChildProfile.ParentId == parent_id)
            .order_by(ChildProfile.CreatedAt.desc(), ChildProfile.Id.asc())
        )
        children = [
            {
                "id": child.id,
                "alias": child.alias,
                "grade": child.grade,
                "created_at": child.created_at,
            }
            for child in child_result.all()
        ]

        return {
            "id": parent.id,
            "display_name": parent.display_name,
            "created_at": parent.created_at,
            "children": children,
        }

    async def list_parent_rows(
        self,
        search: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        """Return visible Parent records, pagination metadata, and child counts."""
        filters = [Profile.Role == "parent"]
        if search and search.strip():
            term = (
                search.strip()
                .replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_")
            )
            filters.append(Profile.DisplayName.ilike(f"%{term}%", escape="\\"))

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

    async def update_display_name(
        self, parent_id: UUID, display_name: str | None
    ) -> dict[str, Any] | None:
        """Update only the display name; relationship and role fields stay untouched."""
        parent = await self.get_parent_record(parent_id)
        if parent is None:
            return None

        result = await self.db.execute(
            update(Profile)
            .where(
                Profile.Id == parent_id,
                Profile.Role == "parent",
            )
            .values(DisplayName=display_name)
            .returning(Profile.Id)
        )
        if result.scalar_one_or_none() is None:
            await self.db.rollback()
            return None
        await self.db.commit()
        return parent
}
