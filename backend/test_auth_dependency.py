"""Supabase JWT verification distinguishes invalid credentials from outages."""

import os
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app.api.deps import get_current_parent_id


ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")
CREDENTIALS = HTTPAuthorizationCredentials(
    scheme="Bearer",
    credentials="isolated-test-token",
)


class ProviderError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class AuthenticationDependencyTests(unittest.TestCase):
    def test_missing_credentials_remain_unauthorized(self):
        with self.assertRaises(HTTPException) as caught:
            get_current_parent_id(None)
        self.assertEqual(caught.exception.status_code, 401)

    def test_valid_provider_user_returns_authenticated_uuid(self):
        supabase = SimpleNamespace(
            auth=SimpleNamespace(
                get_user=Mock(
                    return_value=SimpleNamespace(
                        user=SimpleNamespace(id=str(ACTOR_ID))
                    )
                )
            )
        )
        with patch("app.api.deps.get_supabase_client", return_value=supabase):
            self.assertEqual(get_current_parent_id(CREDENTIALS), ACTOR_ID)
        supabase.auth.get_user.assert_called_once_with(CREDENTIALS.credentials)

    def test_provider_rejection_for_invalid_jwt_remains_401(self):
        supabase = SimpleNamespace(
            auth=SimpleNamespace(
                get_user=Mock(side_effect=ProviderError("invalid token", 401))
            )
        )
        with patch("app.api.deps.get_supabase_client", return_value=supabase):
            with self.assertRaises(HTTPException) as caught:
                get_current_parent_id(CREDENTIALS)
        self.assertEqual(caught.exception.status_code, 401)
        self.assertEqual(
            caught.exception.detail,
            "Invalid authentication credentials",
        )

    def test_provider_outage_without_http_status_returns_503_not_401(self):
        supabase = SimpleNamespace(
            auth=SimpleNamespace(
                get_user=Mock(
                    side_effect=ProviderError("private transport diagnostic")
                )
            )
        )
        with patch("app.api.deps.get_supabase_client", return_value=supabase):
            with self.assertLogs("app.api.deps", level="WARNING") as captured:
                with self.assertRaises(HTTPException) as caught:
                    get_current_parent_id(CREDENTIALS)

        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(
            caught.exception.detail,
            "Authentication service temporarily unavailable",
        )
        diagnostic = "\n".join(captured.output)
        self.assertIn("supabase_auth_verification_unavailable", diagnostic)
        self.assertNotIn("private transport diagnostic", diagnostic)
        self.assertNotIn(CREDENTIALS.credentials, diagnostic)

    def test_provider_server_error_returns_503(self):
        supabase = SimpleNamespace(
            auth=SimpleNamespace(
                get_user=Mock(side_effect=ProviderError("provider unavailable", 503))
            )
        )
        with patch("app.api.deps.get_supabase_client", return_value=supabase):
            with self.assertRaises(HTTPException) as caught:
                get_current_parent_id(CREDENTIALS)
        self.assertEqual(caught.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
