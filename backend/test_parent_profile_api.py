"""Tests for the authenticated Parent Profile response contract."""

import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_KEY"] = "isolated-test-key"

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import profile as profile_routes

PARENT_ID = UUID("22222222-2222-4222-8222-222222222222")
OTHER_ID = UUID("44444444-4444-4444-8444-444444444444")
CHILD_ID = UUID("33333333-3333-4333-8333-333333333333")
CREATED_AT = datetime(2026, 10, 1, tzinfo=timezone.utc)


def make_client(actor_id: UUID = PARENT_ID) -> TestClient:
    app = FastAPI()
    app.include_router(profile_routes.router, prefix="/profiles")

    async def fake_db():
        return object()

    app.dependency_overrides[get_db] = fake_db
    app.dependency_overrides[get_current_parent_id] = lambda: actor_id
    return TestClient(app)


class ParentProfileApiTests(unittest.TestCase):
    def test_profile_returns_auth_contact_and_safe_child_summary(self):
        child = SimpleNamespace(
            Id=CHILD_ID,
            Alias="Bé An",
            Grade=2,
            CreatedAt=CREATED_AT,
        )
        profile = SimpleNamespace(
            Id=PARENT_ID,
            DisplayName="Ba mẹ An",
            Role="parent",
            CreatedAt=CREATED_AT,
            ContactPhone="+84900000000",
            children=[child],
        )
        repository = MagicMock()
        repository.get_by_id = AsyncMock(return_value=profile)
        provider = MagicMock()
        provider.get_contact_info = AsyncMock(
            return_value={
                "email": "parent@example.com",
                "phone": "+84999999999",
                "email_verified": True,
                "phone_verified": True,
                "contact_info_status": "available",
            }
        )

        with patch.object(profile_routes, "ProfileRepository", return_value=repository):
            with patch(
                "app.services.profile_service.SupabaseAuthContactProvider",
                return_value=provider,
            ):
                with make_client() as client:
                    response = client.get("/profiles/me")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["email"], "parent@example.com")
        self.assertEqual(body["contact_phone"], "+84900000000")
        self.assertTrue(body["email_verified"])
        self.assertNotIn("phone", body)
        self.assertNotIn("phone_verified", body)
        self.assertEqual(body["children"][0]["alias"], "Bé An")
        self.assertEqual(body["children"][0]["grade"], 2)
        self.assertNotIn("settings", body["children"][0])
        self.assertNotIn("password", body)

    def test_profile_remains_available_when_auth_contact_lookup_is_unavailable(self):
        profile = SimpleNamespace(
            Id=PARENT_ID,
            DisplayName="Ba mẹ An",
            Role="parent",
            CreatedAt=CREATED_AT,
            ContactPhone=None,
            children=[],
        )
        repository = MagicMock()
        repository.get_by_id = AsyncMock(return_value=profile)
        provider = MagicMock()
        provider.get_contact_info = AsyncMock(
            return_value={
                "email": None,
                "phone": None,
                "email_verified": None,
                "phone_verified": None,
                "contact_info_status": "not_configured",
            }
        )

        with patch.object(profile_routes, "ProfileRepository", return_value=repository):
            with patch(
                "app.services.profile_service.SupabaseAuthContactProvider",
                return_value=provider,
            ):
                with make_client() as client:
                    response = client.get("/profiles/me")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIsNone(body["contact_phone"])
        self.assertNotIn("phone_verified", body)
        self.assertEqual(body["contact_info_status"], "not_configured")
        self.assertEqual(body["children"], [])

    def test_contact_phone_update_saves_to_profile_without_auth_phone_change(self):
        profile = SimpleNamespace(
            Id=PARENT_ID,
            DisplayName="Ba mẹ An",
            Role="parent",
            CreatedAt=CREATED_AT,
            ContactPhone="+84912345678",
            children=[],
        )
        repository = MagicMock()
        repository.update_contact_phone = AsyncMock(return_value=profile)
        repository.get_by_id = AsyncMock(return_value=profile)
        provider = MagicMock()
        provider.get_contact_info = AsyncMock(
            return_value={
                "email": "parent@example.com",
                "phone": "+84900000000",
                "pending_email": None,
                "email_verified": True,
                "contact_info_status": "available",
            }
        )

        with patch.object(profile_routes, "ProfileRepository", return_value=repository):
            with patch(
                "app.services.profile_service.SupabaseAuthContactProvider",
                return_value=provider,
            ):
                with make_client() as client:
                    response = client.patch(
                        "/profiles/me/contact-phone",
                        json={"contact_phone": "+84912345678"},
                    )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["contact_phone"], "+84912345678")
        self.assertNotIn("phone", body)
        self.assertNotIn("phone_verified", body)
        repository.update_contact_phone.assert_awaited_once_with(
            PARENT_ID,
            "+84912345678",
        )

    def test_contact_phone_update_rejects_local_format_before_persistence(self):
        repository = MagicMock()
        repository.update_contact_phone = AsyncMock()

        with patch.object(profile_routes, "ProfileRepository", return_value=repository):
            with make_client() as client:
                response = client.patch(
                    "/profiles/me/contact-phone",
                    json={"contact_phone": "0912345678"},
                )

        self.assertEqual(response.status_code, 422)
        repository.update_contact_phone.assert_not_awaited()

    def test_generic_profile_listing_is_admin_only(self):
        repository = MagicMock()
        repository.get_role = AsyncMock(return_value="parent")
        repository.list_all_profiles = AsyncMock()

        with patch.object(profile_routes, "ProfileRepository", return_value=repository):
            with make_client() as client:
                response = client.get("/profiles/")

        self.assertEqual(response.status_code, 403)
        repository.list_all_profiles.assert_not_awaited()

    def test_generic_profile_creation_is_admin_only(self):
        repository = MagicMock()
        repository.get_role = AsyncMock(return_value="parent")

        with patch.object(profile_routes, "ProfileRepository", return_value=repository):
            with make_client() as client:
                response = client.post(
                    "/profiles/",
                    json={"Role": "parent", "DisplayName": "Không được tạo"},
                )

        self.assertEqual(response.status_code, 403)

    def test_generic_profile_deletion_is_admin_only(self):
        repository = MagicMock()
        repository.get_role = AsyncMock(return_value="parent")

        with patch.object(profile_routes, "ProfileRepository", return_value=repository):
            with make_client() as client:
                response = client.delete(f"/profiles/{PARENT_ID}")

        self.assertEqual(response.status_code, 403)

    def test_id_based_profile_read_rejects_another_users_profile(self):
        with make_client() as client:
            response = client.get(f"/profiles/{OTHER_ID}")
        self.assertEqual(response.status_code, 403)

    def test_id_based_profile_update_rejects_another_users_profile(self):
        with make_client() as client:
            response = client.put(
                f"/profiles/{OTHER_ID}",
                json={"Role": "parent", "displayname": "Someone Else"},
            )
        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
