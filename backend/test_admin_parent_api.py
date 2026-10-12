"""API contract tests for Admin parent list and detail endpoints."""
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_KEY"] = "isolated-test-key"

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import profile as profile_routes


ADMIN_ID = UUID("11111111-1111-4111-8111-111111111111")
PARENT_ID = UUID("22222222-2222-4222-8222-222222222222")
CHILD_ID = UUID("33333333-3333-4333-8333-333333333333")
CREATED_AT = datetime(2026, 10, 1, tzinfo=timezone.utc)


def make_client(actor_id: UUID | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(profile_routes.router, prefix="/profiles")

    async def fake_db():
        return object()

    app.dependency_overrides[get_db] = fake_db
    if actor_id is not None:
        def authenticated_actor():
            return actor_id
        app.dependency_overrides[get_current_parent_id] = authenticated_actor

    return TestClient(app)


class AdminParentApiTests(unittest.TestCase):
    def test_list_requires_authentication(self):
        with make_client() as client:
            response = client.get("/profiles/admin/parents")
        self.assertEqual(response.status_code, 401)

    def test_list_rejects_non_admin_with_403(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value="parent")
        repository.list_parent_rows = AsyncMock()

        with patch.object(profile_routes, "AdminParentRepository", return_value=repository):
            with make_client(PARENT_ID) as client:
                response = client.get("/profiles/admin/parents")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["detail"]["code"], "FORBIDDEN")
        repository.list_parent_rows.assert_not_awaited()

    def test_list_validates_query_parameters(self):
        with make_client(ADMIN_ID) as client:
            response = client.get("/profiles/admin/parents?limit=101")
        self.assertEqual(response.status_code, 422)

    def test_list_returns_existing_response_contract(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value="admin")
        repository.list_parent_rows = AsyncMock(
            return_value=(
                [{
                    "id": PARENT_ID,
                    "display_name": "Nguyen Van A",
                    "created_at": CREATED_AT,
                    "children_count": 2,
                }],
                1,
            )
        )

        with patch.object(profile_routes, "AdminParentRepository", return_value=repository):
            with make_client(ADMIN_ID) as client:
                response = client.get(
                    "/profiles/admin/parents?search=Nguyen&limit=10&offset=0"
                )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["limit"], 10)
        self.assertEqual(body["offset"], 0)
        self.assertEqual(body["items"][0]["id"], str(PARENT_ID))
        self.assertEqual(body["items"][0]["children_count"], 2)
        repository.list_parent_rows.assert_awaited_once_with(
            search="Nguyen",
            limit=10,
            offset=0,
        )

    def test_detail_validates_parent_uuid(self):
        with make_client(ADMIN_ID) as client:
            response = client.get("/profiles/admin/parents/not-a-uuid")
        self.assertEqual(response.status_code, 422)

    def test_detail_returns_404_for_missing_parent(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value="admin")
        repository.get_parent_detail = AsyncMock(return_value=None)

        with patch.object(profile_routes, "AdminParentRepository", return_value=repository):
            with make_client(ADMIN_ID) as client:
                response = client.get(f"/profiles/admin/parents/{PARENT_ID}")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"]["code"], "RESOURCE_NOT_FOUND")

    def test_detail_returns_safe_contact_and_child_projection(self):
        repository = MagicMock()
        repository.role = AsyncMock(return_value="admin")
        repository.get_parent_detail = AsyncMock(
            return_value={
                "id": PARENT_ID,
                "display_name": "Nguyen Van A",
                "created_at": CREATED_AT,
                "children": [{
                    "id": CHILD_ID,
                    "alias": "Be An",
                    "grade": 2,
                    "created_at": CREATED_AT,
                }],
            }
        )
        provider = MagicMock()
        provider.get_contact_info = AsyncMock(
            return_value={
                "email": "parent@example.com",
                "phone": "0900000000",
                "contact_info_status": "available",
            }
        )

        with patch.object(profile_routes, "AdminParentRepository", return_value=repository):
            with patch("app.services.admin_parent_service.SupabaseAuthContactProvider", return_value=provider):
                with make_client(ADMIN_ID) as client:
                    response = client.get(f"/profiles/admin/parents/{PARENT_ID}")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["id"], str(PARENT_ID))
        self.assertEqual(body["email"], "parent@example.com")
        self.assertEqual(body["phone"], "0900000000")
        self.assertEqual(body["children"][0]["id"], str(CHILD_ID))
        self.assertEqual(body["children"][0]["alias"], "Be An")
        self.assertEqual(body["contact_info_status"], "available")
        self.assertNotIn("password", body)
        self.assertNotIn("reauthentication_token", body)


    def test_hide_endpoint_only_updates_visibility_and_never_deletes(self):
        hidden_at = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)
        repository = MagicMock()
        repository.role = AsyncMock(return_value="admin")
        repository.get_parent_record = AsyncMock(
            return_value={"id": PARENT_ID, "admin_hidden_at": None}
        )
        repository.set_hidden = AsyncMock(
            return_value={"id": PARENT_ID, "admin_hidden_at": hidden_at}
        )
        repository.delete = AsyncMock()

        with patch.object(profile_routes, "AdminParentRepository", return_value=repository):
            with make_client(ADMIN_ID) as client:
                response = client.delete(f"/profiles/admin/parents/{PARENT_ID}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["id"], str(PARENT_ID))
        self.assertTrue(response.json()["is_hidden"])
        repository.set_hidden.assert_awaited_once()
        repository.delete.assert_not_awaited()

    def test_restore_endpoint_is_authorized_and_returns_visible_state(self):
        hidden_at = datetime(2026, 10, 11, 12, 0, tzinfo=timezone.utc)
        repository = MagicMock()
        repository.role = AsyncMock(return_value="admin")
        repository.get_parent_record = AsyncMock(
            return_value={"id": PARENT_ID, "admin_hidden_at": hidden_at}
        )
        repository.set_hidden = AsyncMock(
            return_value={"id": PARENT_ID, "admin_hidden_at": None}
        )
        repository.delete = AsyncMock()

        with patch.object(profile_routes, "AdminParentRepository", return_value=repository):
            with make_client(ADMIN_ID) as client:
                response = client.patch(
                    f"/profiles/admin/parents/{PARENT_ID}/visibility",
                    json={"is_hidden": False},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["id"], str(PARENT_ID))
        self.assertFalse(response.json()["is_hidden"])
        self.assertIsNone(response.json()["admin_hidden_at"])
        repository.set_hidden.assert_awaited_once_with(PARENT_ID, None)
        repository.delete.assert_not_awaited()

    def test_hide_endpoint_rejects_unauthenticated_request(self):
        with make_client() as client:
            response = client.delete(f"/profiles/admin/parents/{PARENT_ID}")
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
