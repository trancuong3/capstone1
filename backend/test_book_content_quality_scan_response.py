"""Regression coverage for responses built before workflow transaction cleanup."""
from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from sqlalchemy.exc import MissingGreenlet

from app.services.book_content_quality_service import BookContentQualityService


ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")
BOOK_ID = UUID("22222222-2222-4222-8222-222222222222")
CREATED_AT = datetime(2026, 11, 21, tzinfo=timezone.utc)


class BookQualityScanResponseTests(unittest.IsolatedAsyncioTestCase):
    async def test_scan_response_is_snapshotted_before_workflow_rollback(self):
        created_runs = []

        class ExpiringRun:
            def __init__(self, **values):
                values.setdefault("TotalPages", 0)
                values.setdefault("CompletedPages", 0)
                values.setdefault("SkippedPages", 0)
                values.setdefault("FailedPages", 0)
                values.setdefault("AICompletedPages", 0)
                values.setdefault("AIUnavailablePages", 0)
                values.setdefault("ErrorSummary", None)
                values.setdefault("StartedAt", None)
                values.setdefault("CompletedAt", None)
                values.setdefault("CreatedAt", CREATED_AT)
                object.__setattr__(self, "_values", values)
                object.__setattr__(self, "_expired", False)
                created_runs.append(self)

            def __getattr__(self, name):
                if object.__getattribute__(self, "_expired"):
                    raise MissingGreenlet(f"{name} was expired by workflow rollback")
                values = object.__getattribute__(self, "_values")
                if name not in values:
                    raise AttributeError(name)
                return values[name]

            def expire(self):
                object.__setattr__(self, "_expired", True)

        db = SimpleNamespace(
            add=MagicMock(),
            commit=AsyncMock(),
            refresh=AsyncMock(),
            rollback=AsyncMock(),
        )
        repository = SimpleNamespace(
            db=db,
            book=AsyncMock(return_value=SimpleNamespace(Id=BOOK_ID, Title="Book")),
            active_scan_for_book=AsyncMock(return_value=None),
            latest_scan=AsyncMock(return_value=None),
        )
        service = BookContentQualityService(repository)
        service._require_role = AsyncMock()

        async def queue_workflows(_actor_id, _book_id):
            created_runs[0].expire()
            await db.rollback()

        service._ensure_page_ai_workflows = AsyncMock(side_effect=queue_workflows)

        with patch(
            "app.services.book_content_quality_service.BookQualityScanRun",
            side_effect=ExpiringRun,
        ):
            response = await service.enqueue_scan(ACTOR_ID, BOOK_ID)

        self.assertEqual(response.id, created_runs[0]._values["Id"])
        self.assertEqual(response.status, "QUEUED")
        self.assertEqual(response.book_id, BOOK_ID)
        db.commit.assert_awaited_once()
        service._ensure_page_ai_workflows.assert_awaited_once_with(ACTOR_ID, BOOK_ID)

