from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


class VireadOcrTrainingRepository:
    """SQL-only persistence for the private VietOCR training registry."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def one(self, sql: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        result = await self.db.execute(text(sql), params or {})
        row = result.mappings().first()
        return dict(row) if row else None

    async def all(self, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        result = await self.db.execute(text(sql), params or {})
        return [dict(row) for row in result.mappings().all()]

    async def execute(self, sql: str, params: Any = None) -> Any:
        return await self.db.execute(text(sql), params or {})

    async def commit(self) -> None:
        await self.db.commit()

    async def rollback(self) -> None:
        await self.db.rollback()
