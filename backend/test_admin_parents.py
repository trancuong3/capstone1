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

    async def test_admin_receives_parent_detail_and_only_linked_children(self):
        child_id = UUID("33333333-3333-4333-8333-333333333333")
        repository = MagicMock()
        repository.role = AsyncMock(return_value="admin")
        repository.get_parent_detail = AsyncMock(
            return_value={
                "id": PARENT_ID,
                "display_name": "Nguyen Van A",
                "created_at": CREATED_AT,
                "children": [
                    {
                        "id": child_id,
                        "alias": "Be An",
                        "grade": 2,
                        "created_at": CREATED_AT,
                    }
                ],
            }
        )
        auth_provider = MagicMock()
        auth_provider.get_contact_info = AsyncMock(
            return_value={
                "email": "parent@example.com",
                "phone": "0900000000",
                "contact_info_status": "available",
            }
        )

        response = await AdminParentService(repository).get_parent_detail(
            actor_id=ADMIN_ID,
            parent_id=PARENT_ID,
            auth_contact_provider=auth_provider,
        )

        self.assertEqual(response.id, PARENT_ID)
        self.assertEqual(response.email, "parent@example.com")
        self.assertEqual(response.phone, "0900000000")
        self.assertEqual(len(response.children), 1)
        self.assertEqual(response.children[0].id, child_id)
        self.assertEqual(response.children[0].alias, "Be An")
        self.assertEqual(response.children[0].grade, 2)
        self.assertFalse(hasattr(response, "password"))
        self.assertFalse(hasattr(response, "reauthentication_token"))
        repository.get_parent_detail.assert_awaited_once_with(PARENT_ID)
        auth_provider.get_contact_info.assert_awaited_once_with(PARENT_ID)

    async def test_non_admin_cannot_read_parent_detail(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value="parent")
        repository.get_parent_detail = AsyncMock()
        auth_provider = MagicMock()
        auth_provider.get_contact_info = AsyncMock()

        with self.assertRaises(HTTPException) as caught:
            await AdminParentService(repository).get_parent_detail(
                actor_id=PARENT_ID,
                parent_id=ADMIN_ID,
                auth_contact_provider=auth_provider,
            )

        self.assertEqual(caught.exception.status_code, 403)
        repository.get_parent_detail.assert_not_awaited()
        auth_provider.get_contact_info.assert_not_awaited()

    async def test_missing_parent_returns_404_without_auth_lookup(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value="admin")
        repository.get_parent_detail = AsyncMock(return_value=None)
        auth_provider = MagicMock()
        auth_provider.get_contact_info = AsyncMock()

        with self.assertRaises(HTTPException) as caught:
            await AdminParentService(repository).get_parent_detail(
                actor_id=ADMIN_ID,
                parent_id=PARENT_ID,
                auth_contact_provider=auth_provider,
            )

        self.assertEqual(caught.exception.status_code, 404)
        auth_provider.get_contact_info.assert_not_awaited()

    async def test_parent_detail_survives_unavailable_auth_contact_data(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value="admin")
        repository.get_parent_detail = AsyncMock(
            return_value={
                "id": PARENT_ID,
                "display_name": "Nguyen Van A",
                "created_at": CREATED_AT,
                "children": [],
            }
        )
        auth_provider = MagicMock()
        auth_provider.get_contact_info = AsyncMock(
            return_value={
                "email": None,
                "phone": None,
                "contact_info_status": "not_configured",
            }
        )

        response = await AdminParentService(repository).get_parent_detail(
            actor_id=ADMIN_ID,
            parent_id=PARENT_ID,
            auth_contact_provider=auth_provider,
        )

        self.assertIsNone(response.email)
        self.assertIsNone(response.phone)
        self.assertEqual(response.contact_info_status, "not_configured")
        self.assertEqual(response.children, [])




if __name__ == "__main__":
    unittest.main()
