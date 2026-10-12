"""Unit tests for Admin parent service orchestration."""
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_KEY"] = "isolated-test-key"

from app.services.admin_parent_service import (
    AdminParentAccessDeniedError,
    AdminParentNotFoundError,
    AdminParentService,
)


ADMIN_ID = UUID("11111111-1111-4111-8111-111111111111")
PARENT_ID = UUID("22222222-2222-4222-8222-222222222222")
CHILD_ID = UUID("33333333-3333-4333-8333-333333333333")
CREATED_AT = datetime(2026, 10, 1, tzinfo=timezone.utc)


class AdminParentServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_admin_receives_parent_projection_and_pagination(self):
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

        result = await AdminParentService(repository).list_parents(
            actor_id=ADMIN_ID,
            search="Nguyen",
            limit=10,
            offset=0,
        )

        self.assertEqual(result.total, 1)
        self.assertEqual(result.limit, 10)
        self.assertEqual(result.offset, 0)
        self.assertEqual(result.items[0]["id"], PARENT_ID)
        self.assertEqual(result.items[0]["display_name"], "Nguyen Van A")
        self.assertEqual(result.items[0]["children_count"], 2)
        self.assertNotIn("password", result.items[0])
        repository.list_parent_rows.assert_awaited_once_with(
            search="Nguyen",
            limit=10,
            offset=0,
        )

    async def test_parent_cannot_read_admin_parent_directory(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value="parent")
        repository.list_parent_rows = AsyncMock()

        with self.assertRaises(AdminParentAccessDeniedError):
            await AdminParentService(repository).list_parents(
                actor_id=PARENT_ID,
                search=None,
                limit=10,
                offset=0,
            )

        repository.list_parent_rows.assert_not_awaited()

    async def test_unknown_role_is_denied_before_query(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value=None)
        repository.list_parent_rows = AsyncMock()

        with self.assertRaises(AdminParentAccessDeniedError):
            await AdminParentService(repository).list_parents(
                actor_id=ADMIN_ID,
                search=None,
                limit=10,
                offset=0,
            )

        repository.list_parent_rows.assert_not_awaited()

    async def test_admin_receives_parent_detail_and_linked_children(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value="admin")
        repository.get_parent_detail = AsyncMock(
            return_value={
                "id": PARENT_ID,
                "display_name": "Nguyen Van A",
                "created_at": CREATED_AT,
                "children": [
                    {
                        "id": CHILD_ID,
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

        result = await AdminParentService(
            repository,
            auth_contact_provider=auth_provider,
        ).get_parent_detail(ADMIN_ID, PARENT_ID)

        self.assertEqual(result.id, PARENT_ID)
        self.assertEqual(result.email, "parent@example.com")
        self.assertEqual(result.phone, "0900000000")
        self.assertEqual(len(result.children), 1)
        self.assertEqual(result.children[0]["id"], CHILD_ID)
        self.assertEqual(result.children[0]["alias"], "Be An")
        self.assertEqual(result.children[0]["grade"], 2)
        self.assertFalse(hasattr(result, "password"))
        self.assertFalse(hasattr(result, "reauthentication_token"))
        repository.get_parent_detail.assert_awaited_once_with(PARENT_ID)
        auth_provider.get_contact_info.assert_awaited_once_with(PARENT_ID)

    async def test_non_admin_cannot_read_parent_detail(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value="parent")
        repository.get_parent_detail = AsyncMock()
        auth_provider = MagicMock()
        auth_provider.get_contact_info = AsyncMock()

        with self.assertRaises(AdminParentAccessDeniedError):
            await AdminParentService(
                repository,
                auth_contact_provider=auth_provider,
            ).get_parent_detail(PARENT_ID, ADMIN_ID)

        repository.get_parent_detail.assert_not_awaited()
        auth_provider.get_contact_info.assert_not_awaited()

    async def test_missing_parent_raises_domain_error_without_auth_lookup(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value="admin")
        repository.get_parent_detail = AsyncMock(return_value=None)
        auth_provider = MagicMock()
        auth_provider.get_contact_info = AsyncMock()

        with self.assertRaises(AdminParentNotFoundError):
            await AdminParentService(
                repository,
                auth_contact_provider=auth_provider,
            ).get_parent_detail(ADMIN_ID, PARENT_ID)

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

        result = await AdminParentService(
            repository,
            auth_contact_provider=auth_provider,
        ).get_parent_detail(ADMIN_ID, PARENT_ID)

        self.assertIsNone(result.email)
        self.assertIsNone(result.phone)
        self.assertEqual(result.contact_info_status, "not_configured")
        self.assertEqual(result.children, [])

    async def test_unexpected_auth_provider_error_preserves_parent_detail(self):
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
            side_effect=RuntimeError("sensitive internal detail"),
        )

        result = await AdminParentService(
            repository,
            auth_contact_provider=auth_provider,
        ).get_parent_detail(ADMIN_ID, PARENT_ID)

        self.assertIsNone(result.email)
        self.assertIsNone(result.phone)
        self.assertEqual(result.contact_info_status, "lookup_failed")
        self.assertEqual(result.id, PARENT_ID)


if __name__ == "__main__":
    unittest.main()
