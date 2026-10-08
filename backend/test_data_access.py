"""Phase 2 identity tests, with no live Supabase or database calls."""

import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

# Dummy values apply only to this test process, never to project env files.
os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_KEY"] = "isolated-test-key"

from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app.api.deps import get_current_parent_id


class IdentityTests(unittest.TestCase):
    def test_missing_credentials_are_unauthorized(self):
        with patch("app.api.deps.get_supabase_client") as get_client:
            with self.assertRaises(HTTPException) as caught:
                get_current_parent_id(None)
        self.assertEqual(caught.exception.status_code, 401)
        get_client.assert_not_called()

    def test_identity_comes_from_verified_user_not_request_id(self):
        user_id = UUID("11111111-1111-4111-8111-111111111111")
        with patch("app.api.deps.get_supabase_client") as get_client:
            get_client.return_value.auth.get_user.return_value = SimpleNamespace(
                user=SimpleNamespace(id=str(user_id))
            )
            result = get_current_parent_id(
                HTTPAuthorizationCredentials(scheme="Bearer", credentials="test-token")
            )
        self.assertEqual(result, user_id)
        get_client.return_value.auth.get_user.assert_called_once_with("test-token")

    def test_provider_failure_is_generic(self):
        with patch("app.api.deps.get_supabase_client") as get_client:
            get_client.return_value.auth.get_user.side_effect = RuntimeError("private-key")
            with self.assertRaises(HTTPException) as caught:
                get_current_parent_id(
                    HTTPAuthorizationCredentials(scheme="Bearer", credentials="bad-token")
                )
        self.assertEqual(caught.exception.status_code, 401)
        self.assertNotIn("private-key", caught.exception.detail)

    def test_missing_or_invalid_user_id_is_unauthorized(self):
        for user in (None, SimpleNamespace(id="not-a-uuid")):
            with self.subTest(user=user):
                with patch("app.api.deps.get_supabase_client") as get_client:
                    get_client.return_value.auth.get_user.return_value = SimpleNamespace(user=user)
                    with self.assertRaises(HTTPException) as caught:
                        get_current_parent_id(
                            HTTPAuthorizationCredentials(scheme="Bearer", credentials="test-token")
                        )
                self.assertEqual(caught.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
