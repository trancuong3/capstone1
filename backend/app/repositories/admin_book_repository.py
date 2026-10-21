"""Persistence operations for Admin book metadata and lifecycle changes."""
from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Book, Profile


class AdminBookRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, actor_id: UUID) -> str | None:
        return await self.db.scalar(select(Profile.Role).where(Profile.Id == actor_id))

    async def get(self, book_id: UUID) -> Book | None:
        return await self.db.scalar(select(Book).where(Book.Id == book_id))

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

