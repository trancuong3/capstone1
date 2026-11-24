"""Persistence operations for Admin book metadata and lifecycle changes."""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.role_cache import get_cached_profile_role
from app.models import Book
from app.repositories.book_repository import CatalogRepository


class AdminBookRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, actor_id: UUID) -> str | None:
        return await get_cached_profile_role(self.db, actor_id)

    async def get(self, book_id: UUID) -> Book | None:
        return await self.db.scalar(
            select(Book).where(
                Book.Id == book_id,
                Book.VisibilityScope == "CATALOG",
                Book.IsDeleted.is_(False),
            )
        )

    async def soft_delete(self, book_id: UUID, *, actor_id: UUID) -> bool:
        """Mark a catalog book deleted while retaining its row and all related data.

        The row lock serializes concurrent Admin requests. A repeated request
        returns the existing deletion state without changing its original actor
        or timestamp.
        """
        book = await self.db.scalar(
            select(Book)
            .where(Book.Id == book_id, Book.VisibilityScope == "CATALOG")
            .with_for_update()
        )
        if book is None:
            return False
        if book.IsDeleted:
            return True

        book.IsDeleted = True
        book.DeletedAt = datetime.now(timezone.utc)
        book.DeletedBy = actor_id
        try:
            await self.db.commit()
        except Exception:
            await self.db.rollback()
            raise
        return True

    async def is_ready_for_children(self, book_id: UUID) -> bool:
        return await CatalogRepository(self.db).is_ready_for_children(book_id)

    async def create(self, *, actor_id: UUID, values: dict[str, object]) -> Book:
        book = Book(
            Name=str(values["name"]),
            Title=str(values["title"]),
            Author=values.get("author"),
            MinGrade=int(values["min_grade"]),
            MaxGrade=int(values["max_grade"]),
            LifecycleStatus="ACTIVE",
            CreatedBy=actor_id,
        )
        self.db.add(book)
        try:
            await self.db.commit()
            await self.db.refresh(book)
        except Exception:
            await self.db.rollback()
            raise
        return book

    async def update_metadata(self, book: Book, *, values: dict[str, object]) -> Book:
        book.Name = str(values["name"])
        book.Title = str(values["title"])
        book.Author = values.get("author")
        book.MinGrade = int(values["min_grade"])
        book.MaxGrade = int(values["max_grade"])
        try:
            await self.db.commit()
            await self.db.refresh(book)
        except Exception:
            await self.db.rollback()
            raise
        return book

    async def set_lifecycle(self, book: Book, status: str) -> Book:
        book.LifecycleStatus = status
        try:
            await self.db.commit()
            await self.db.refresh(book)
        except Exception:
            await self.db.rollback()
            raise
        return book
