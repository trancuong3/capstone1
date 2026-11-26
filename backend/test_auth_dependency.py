"""Supabase JWT verification distinguishes invalid credentials from outages."""

import base64
import json
import os
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app.api import deps as deps_mod
from app.api.deps import (
    _auth_token_cache_ttl_seconds,
    clear_auth_token_cache,
    get_current_parent_id,
)
from app.database import role_cache as role_cache_mod


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

    def test_provider_forbidden_is_not_misreported_as_invalid_user_jwt(self):
        supabase = SimpleNamespace(
            auth=SimpleNamespace(
                get_user=Mock(side_effect=ProviderError("provider access denied", 403))
            )
        )
        with patch("app.api.deps.get_supabase_client", return_value=supabase):
            with self.assertRaises(HTTPException) as caught:
                get_current_parent_id(CREDENTIALS)
        self.assertEqual(caught.exception.status_code, 503)

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


    def test_short_lived_token_cache_reuses_verified_actor_and_never_caches_errors(self):
        clear_auth_token_cache()
        self.addCleanup(clear_auth_token_cache)
        supabase = SimpleNamespace(
            auth=SimpleNamespace(
                get_user=Mock(
                    return_value=SimpleNamespace(
                        user=SimpleNamespace(id=str(ACTOR_ID))
                    )
                )
            )
        )
        with (
            patch.dict(os.environ, {"AUTH_TOKEN_CACHE_TTL_SECONDS": "30"}, clear=False),
            patch("app.api.deps.get_supabase_client", return_value=supabase),
        ):
            self.assertEqual(get_current_parent_id(CREDENTIALS), ACTOR_ID)
            self.assertEqual(get_current_parent_id(CREDENTIALS), ACTOR_ID)
        supabase.auth.get_user.assert_called_once_with(CREDENTIALS.credentials)

        bad_creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="bad-token")
        failing = SimpleNamespace(
            auth=SimpleNamespace(
                get_user=Mock(side_effect=ProviderError("invalid", 401))
            )
        )
        with (
            patch.dict(os.environ, {"AUTH_TOKEN_CACHE_TTL_SECONDS": "30"}, clear=False),
            patch("app.api.deps.get_supabase_client", return_value=failing),
        ):
            for _ in range(2):
                with self.assertRaises(HTTPException) as caught:
                    get_current_parent_id(bad_creds)
                self.assertEqual(caught.exception.status_code, 401)
        self.assertEqual(failing.auth.get_user.call_count, 2)

    def test_role_cache_and_auth_token_cache_default_ttls_and_jwt_exp_cap(self):
        clear_auth_token_cache()
        self.addCleanup(clear_auth_token_cache)

        # Role cache default is 60s (matching require_active_profile_id docstring)
        if not os.getenv("VIREAD_ROLE_CACHE_TTL_SECONDS"):
            self.assertEqual(role_cache_mod._ROLE_TTL_SECONDS, 60.0)

        # Auth token cache default is 180s in non-test environments and 0s in test
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AUTH_TOKEN_CACHE_TTL_SECONDS", None)
            with patch.object(deps_mod, "APP_ENVIRONMENT", "production"):
                self.assertEqual(_auth_token_cache_ttl_seconds(), 180.0)
            with patch.object(deps_mod, "APP_ENVIRONMENT", "test"):
                self.assertEqual(_auth_token_cache_ttl_seconds(), 0.0)

        # JWT exp strictly caps the cached TTL below 180s
        soon_exp = int(time.time()) + 20
        header = base64.urlsafe_b64encode(b'{"alg":"HS256"}').decode("ascii").rstrip("=")
        payload = base64.urlsafe_b64encode(
            json.dumps({"exp": soon_exp}).encode("utf-8")
        ).decode("ascii").rstrip("=")
        expiring_jwt = f"{header}.{payload}.sig"
        expiring_creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=expiring_jwt)
        supabase = SimpleNamespace(
            auth=SimpleNamespace(
                get_user=Mock(
                    return_value=SimpleNamespace(user=SimpleNamespace(id=str(ACTOR_ID)))
                )
            )
        )
        with (
            patch.object(deps_mod, "APP_ENVIRONMENT", "production"),
            patch("app.api.deps.get_supabase_client", return_value=supabase),
        ):
            before = time.monotonic()
            self.assertEqual(get_current_parent_id(expiring_creds), ACTOR_ID)
            entry = next(iter(deps_mod._AUTH_CACHE.values()))
            # Remaining TTL must be <= ~15s (20s - 5s safety buffer), never 180s
            self.assertLessEqual(entry[1] - before, 16.5)


if __name__ == "__main__":
    unittest.main()
