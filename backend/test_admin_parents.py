"""Unit tests for the read-only Admin parent directory service."""
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_KEY"] = "isolated-test-key"

from fastapi import HTTPException

from app.api.routes.profile import AdminParentService


ADMIN_ID = UUID("11111111-1111-4111-8111-111111111111")
PARENT_ID = UUID("22222222-2222-4222-8222-222222222222")
CREATED_AT = datetime(2026, 10, 1, tzinfo=timezone.utc)


class AdminParentDirectoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_admin_receives_parent_only_projection_and_pagination(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value="admin")
        repository.list_parent_rows = AsyncMock(
            return_value=(
                [
                    {
                        "id": PARENT_ID,
                        "display_name": "Nguyen Van A",
                        "created_at": CREATED_AT,
                        "children_count": 2,
                    }
                ],
                1,
            )
        )

        response = await AdminParentService(repository).list_parents(
            actor_id=ADMIN_ID,
            search="Nguyen",
            limit=10,
            offset=0,
        )

        self.assertEqual(response.total, 1)
        self.assertEqual(response.limit, 10)
        self.assertEqual(response.offset, 0)
        self.assertEqual(response.items[0].id, PARENT_ID)
        self.assertEqual(response.items[0].display_name, "Nguyen Van A")
        self.assertEqual(response.items[0].children_count, 2)
        self.assertFalse(hasattr(response.items[0], "password"))
        repository.list_parent_rows.assert_awaited_once_with(
            search="Nguyen",
            limit=10,
            offset=0,
        )

    async def test_parent_cannot_read_admin_parent_directory(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value="parent")
        repository.list_parent_rows = AsyncMock()

        with self.assertRaises(HTTPException) as caught:
            await AdminParentService(repository).list_parents(
                actor_id=PARENT_ID,
                search=None,
                limit=10,
                offset=0,
            )

        self.assertEqual(caught.exception.status_code, 403)
        repository.list_parent_rows.assert_not_awaited()

    async def test_unknown_role_is_denied_before_query(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value=None)
        repository.list_parent_rows = AsyncMock()

        with self.assertRaises(HTTPException) as caught:
            await AdminParentService(repository).list_parents(
                actor_id=ADMIN_ID,
                search=None,
                limit=10,
                offset=0,
            )

        self.assertEqual(caught.exception.status_code, 403)
        repository.list_parent_rows.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
