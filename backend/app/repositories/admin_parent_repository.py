"""PostgreSQL queries for Admin Parent management.

This repository never calls Supabase Auth. Auth integration belongs to the provider.
"""
from datetime import datetime
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

    async def get_parent_record(
        self, parent_id: UUID, *, include_hidden: bool = False
    ) -> dict[str, Any] | None:
        query = select(Profile).where(
            Profile.Id == parent_id,
            Profile.Role == "parent",
        )
        if not include_hidden:
            query = query.where(Profile.AdminHiddenAt.is_(None))
        result = await self.db.execute(query)
        parent = result.scalar_one_or_none()
        if parent is None:
            return None
        return {
            "id": parent.Id,
            "display_name": parent.DisplayName,
            "created_at": parent.CreatedAt,
            "admin_hidden_at": parent.AdminHiddenAt,
        }

    async def get_parent_detail(
        self, parent_id: UUID, *, include_hidden: bool = False
    ) -> dict[str, Any] | None:
        """Return a safe projection of a Parent and only its linked children."""
        query = select(Profile).where(
            Profile.Id == parent_id,
            Profile.Role == "parent",
        )
        if not include_hidden:
            query = query.where(Profile.AdminHiddenAt.is_(None))
        result = await self.db.execute(query)
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
            "admin_hidden_at": parent.AdminHiddenAt,
            "children": children,
        }

    async def list_parent_rows(
        self,
        search: str | None,
        limit: int,
        offset: int,
        *,
        include_hidden: bool = False,
    ) -> tuple[list[dict[str, Any]], int]:
        """Return matching rows; include_hidden=True selects only hidden parents."""
        filters = [Profile.Role == "parent"]
        filters.append(
            Profile.AdminHiddenAt.is_not(None)
            if include_hidden
            else Profile.AdminHiddenAt.is_(None)
        )
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
                Profile.AdminHiddenAt.label("admin_hidden_at"),
                func.count(ChildProfile.Id).label("children_count"),
            )
            .outerjoin(ChildProfile, ChildProfile.ParentId == Profile.Id)
            .where(*filters)
            .group_by(
                Profile.Id,
                Profile.DisplayName,
                Profile.CreatedAt,
                Profile.AdminHiddenAt,
            )
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
                "admin_hidden_at": row.admin_hidden_at,
                "children_count": row.children_count,
            }
            for row in result.all()
        ]
        return items, int(total or 0)

    async def update_display_name(
        self, parent_id: UUID, display_name: str | None
    ) -> dict[str, Any] | None:
        """Update only the profile display name; no relationship fields are touched."""
        parent = await self.get_parent_record(parent_id)
        if parent is None:
            return None
        result = await self.db.execute(
            update(Profile)
            .where(
                Profile.Id == parent_id,
                Profile.Role == "parent",
                Profile.AdminHiddenAt.is_(None),
            )
            .values(DisplayName=display_name)
            .returning(Profile.Id)
        )
        if result.scalar_one_or_none() is None:
            await self.db.rollback()
            return None
        await self.db.commit()
        return parent

    async def set_hidden(
        self, parent_id: UUID, hidden_at: datetime | None
    ) -> dict[str, Any] | None:
        """Persist Admin visibility as an UPDATE; this method never deletes rows."""
        result = await self.db.execute(
            update(Profile)
            .where(Profile.Id == parent_id, Profile.Role == "parent")
            .values(AdminHiddenAt=hidden_at)
            .returning(
                Profile.Id.label("id"),
                Profile.AdminHiddenAt.label("admin_hidden_at"),
            )
        )
        row = result.one_or_none()
        if row is None:
            await self.db.rollback()
            return None
        await self.db.commit()
        return {"id": row.id, "admin_hidden_at": row.admin_hidden_at}
