from __future__ import annotations

from typing import Any
from uuid import UUID

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

    async def get_active_model_for_update(self) -> dict[str, Any] | None:
        return await self.one(
            "SELECT model_family, checkpoint_sha256, storage_path, profile, decision_id, updated_at "
            "FROM public.viread_ocr_active_model WHERE singleton=TRUE FOR UPDATE"
        )

    async def insert_model_decision(
        self,
        *,
        decision_id: UUID,
        action: str,
        candidate_sha: str,
        previous_sha: str,
        candidate_path: str,
        previous_path: str | None,
        candidate_profile: str,
        previous_profile: str,
        benchmark_id: UUID | None,
        reason: str,
        actor_id: UUID,
    ) -> None:
        await self.execute(
            """
            INSERT INTO public.viread_ocr_model_decisions
                (id, action, candidate_checkpoint_sha256, previous_checkpoint_sha256,
                 candidate_storage_path, previous_storage_path, candidate_profile,
                 previous_profile, benchmark_id, reason, actor_id)
            VALUES (:id, :action, :candidate_sha, :previous_sha, :candidate_path,
                    :previous_path, :candidate_profile, :previous_profile, :benchmark_id,
                    :reason, :actor_id)
            """,
            {
                "id": decision_id,
                "action": action,
                "candidate_sha": candidate_sha,
                "previous_sha": previous_sha,
                "candidate_path": candidate_path,
                "previous_path": previous_path,
                "candidate_profile": candidate_profile,
                "previous_profile": previous_profile,
                "benchmark_id": benchmark_id,
                "reason": reason,
                "actor_id": actor_id,
            },
        )

    async def update_active_model(
        self,
        *,
        checkpoint_sha256: str,
        storage_path: str,
        profile: str,
        decision_id: UUID,
    ) -> None:
        await self.execute(
            """
            UPDATE public.viread_ocr_active_model
            SET checkpoint_sha256=:sha, storage_path=:path, profile=:profile,
                decision_id=:decision_id, updated_at=now()
            WHERE singleton=TRUE
            """,
            {
                "sha": checkpoint_sha256,
                "path": storage_path,
                "profile": profile,
                "decision_id": decision_id,
            },
        )

