"""Supabase JWT verification distinguishes invalid credentials from outages."""

import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from uuid import UUID

import httpx

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app.api import deps
from app.api.deps import (
    aclose_auth_http_clients,
    clear_auth_token_cache,
    get_current_parent_id,
)


ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")
CREDENTIALS = HTTPAuthorizationCredentials(
    scheme="Bearer",
    credentials="isolated-test-token",
)


class ProviderError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class AuthenticationDependencyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        clear_auth_token_cache()
        await aclose_auth_http_clients()

    async def test_missing_credentials_remain_unauthorized(self):
        with self.assertRaises(HTTPException) as caught:
            await get_current_parent_id(None)
        self.assertEqual(caught.exception.status_code, 401)

    async def test_valid_provider_user_returns_authenticated_uuid(self):
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
            self.assertEqual(await get_current_parent_id(CREDENTIALS), ACTOR_ID)
        supabase.auth.get_user.assert_called_once_with(CREDENTIALS.credentials)

    async def test_provider_rejection_for_invalid_jwt_remains_401(self):
        supabase = SimpleNamespace(
            auth=SimpleNamespace(
                get_user=Mock(side_effect=ProviderError("invalid token", 401))
            )
        )
        with patch("app.api.deps.get_supabase_client", return_value=supabase):
            with self.assertRaises(HTTPException) as caught:
                await get_current_parent_id(CREDENTIALS)
        self.assertEqual(caught.exception.status_code, 401)
        self.assertEqual(
            caught.exception.detail,
            "Invalid authentication credentials",
        )

    async def test_provider_outage_without_http_status_returns_503_not_401(self):
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
                    await get_current_parent_id(CREDENTIALS)

        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(
            caught.exception.detail,
            "Authentication service temporarily unavailable",
        )
        diagnostic = "\n".join(captured.output)
        self.assertIn("supabase_auth_verification_unavailable", diagnostic)
        self.assertNotIn("private transport diagnostic", diagnostic)
        self.assertNotIn(CREDENTIALS.credentials, diagnostic)

    async def test_provider_forbidden_is_not_misreported_as_invalid_user_jwt(self):
        supabase = SimpleNamespace(
            auth=SimpleNamespace(
                get_user=Mock(side_effect=ProviderError("provider access denied", 403))
            )
        )
        with patch("app.api.deps.get_supabase_client", return_value=supabase):
            with self.assertRaises(HTTPException) as caught:
                await get_current_parent_id(CREDENTIALS)
        self.assertEqual(caught.exception.status_code, 503)

    async def test_provider_server_error_returns_503(self):
        supabase = SimpleNamespace(
            auth=SimpleNamespace(
                get_user=Mock(side_effect=ProviderError("provider unavailable", 503))
            )
        )
        with patch("app.api.deps.get_supabase_client", return_value=supabase):
            with self.assertRaises(HTTPException) as caught:
                await get_current_parent_id(CREDENTIALS)
        self.assertEqual(caught.exception.status_code, 503)

    async def test_short_lived_token_cache_reuses_verified_actor_and_never_caches_errors(self):
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
            self.assertEqual(await get_current_parent_id(CREDENTIALS), ACTOR_ID)
            self.assertEqual(await get_current_parent_id(CREDENTIALS), ACTOR_ID)
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
                    await get_current_parent_id(bad_creds)
                self.assertEqual(caught.exception.status_code, 401)
        self.assertEqual(failing.auth.get_user.call_count, 2)

    async def test_default_async_http_path_verifies_user_without_sync_client(self):
        seen_requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen_requests.append(request)
            return httpx.Response(200, json={"id": str(ACTOR_ID)})

        real_async_client = deps._REAL_HTTPX_ASYNC_CLIENT
        transport = httpx.MockTransport(handler)
        client = real_async_client(transport=transport)
        self.addAsyncCleanup(client.aclose)

        with (
            patch.object(deps, "_get_auth_http_client", return_value=client),
            patch("app.api.deps.time.sleep", side_effect=AssertionError("must not call time.sleep")),
        ):
            result = await get_current_parent_id(CREDENTIALS)

        self.assertEqual(result, ACTOR_ID)
        self.assertEqual(len(seen_requests), 1)
        req = seen_requests[0]
        self.assertEqual(req.url.path, "/auth/v1/user")
        self.assertEqual(req.headers.get("authorization"), f"Bearer {CREDENTIALS.credentials}")
        self.assertEqual(req.headers.get("apikey"), deps.SUPABASE_KEY)

    async def test_async_http_path_maps_401_and_403_without_retry(self):
        calls = 0

        def handler_401(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(401, json={"message": "bad jwt"})

        c401 = deps._REAL_HTTPX_ASYNC_CLIENT(transport=httpx.MockTransport(handler_401))
        self.addAsyncCleanup(c401.aclose)
        with patch.object(deps, "_get_auth_http_client", return_value=c401):
            with self.assertRaises(HTTPException) as caught_401:
                await get_current_parent_id(CREDENTIALS)
        self.assertEqual(caught_401.exception.status_code, 401)
        self.assertEqual(calls, 1)

        calls_403 = 0

        def handler_403(_request: httpx.Request) -> httpx.Response:
            nonlocal calls_403
            calls_403 += 1
            return httpx.Response(403, json={"message": "forbidden"})

        c403 = deps._REAL_HTTPX_ASYNC_CLIENT(transport=httpx.MockTransport(handler_403))
        self.addAsyncCleanup(c403.aclose)
        with patch.object(deps, "_get_auth_http_client", return_value=c403):
            with self.assertRaises(HTTPException) as caught_403:
                await get_current_parent_id(CREDENTIALS)
        self.assertEqual(caught_403.exception.status_code, 503)
        self.assertEqual(calls_403, 1)

    async def test_async_http_path_retries_transient_error_with_asyncio_sleep(self):
        attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise httpx.RemoteProtocolError("server disconnected", request=request)
            if attempts == 2:
                return httpx.Response(502, text="bad gateway")
            return httpx.Response(200, json={"id": str(ACTOR_ID)})

        client = deps._REAL_HTTPX_ASYNC_CLIENT(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.aclose)
        sleep_mock = AsyncMock()
        with (
            patch.object(deps, "_get_auth_http_client", return_value=client),
            patch("app.api.deps.asyncio.sleep", sleep_mock),
            patch("app.api.deps.time.sleep", side_effect=AssertionError("must not block with time.sleep")),
        ):
            result = await get_current_parent_id(CREDENTIALS)

        self.assertEqual(result, ACTOR_ID)
        self.assertEqual(attempts, 3)
        self.assertEqual(sleep_mock.await_count, 2)

    async def test_async_http_path_exhausted_retries_logs_without_secret_and_returns_503(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("dial failed secret-hint", request=request)

        client = deps._REAL_HTTPX_ASYNC_CLIENT(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.aclose)
        with (
            patch.object(deps, "_get_auth_http_client", return_value=client),
            patch("app.api.deps.asyncio.sleep", AsyncMock()),
        ):
            with self.assertLogs("app.api.deps", level="WARNING") as captured:
                with self.assertRaises(HTTPException) as caught:
                    await get_current_parent_id(CREDENTIALS)

        self.assertEqual(caught.exception.status_code, 503)
        diagnostic = "\n".join(captured.output)
        self.assertIn("supabase_auth_verification_unavailable", diagnostic)
        self.assertNotIn("secret-hint", diagnostic)
        self.assertNotIn(CREDENTIALS.credentials, diagnostic)

    async def test_aclose_auth_http_clients_closes_pooled_loop_clients(self):
        await aclose_auth_http_clients()
        c1 = deps._get_auth_http_client()
        c2 = deps._get_auth_http_client()
        self.assertIsNotNone(c1)
        self.assertIs(c1, c2)
        self.assertFalse(c1.is_closed)
        await aclose_auth_http_clients()
        self.assertTrue(c1.is_closed)
        self.assertEqual(len(deps._AUTH_HTTP_CLIENTS), 0)

    async def test_evict_auth_http_client_does_not_evict_newer_loop_client(self):
        import asyncio

        await aclose_auth_http_clients()
        loop = asyncio.get_running_loop()
        attempts = 0

        def failing_once(request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise httpx.RemoteProtocolError("stale keepalive", request=request)
            return httpx.Response(200, json={"id": str(ACTOR_ID)})

        old_client = deps._REAL_HTTPX_ASYNC_CLIENT(
            transport=httpx.MockTransport(failing_once)
        )
        new_client = deps._REAL_HTTPX_ASYNC_CLIENT(
            transport=httpx.MockTransport(lambda _req: httpx.Response(200, json={"id": str(ACTOR_ID)}))
        )
        self.addAsyncCleanup(old_client.aclose)
        self.addAsyncCleanup(new_client.aclose)

        deps._AUTH_HTTP_CLIENTS[loop] = new_client
        await deps._evict_auth_http_client(old_client)

        self.assertIs(deps._AUTH_HTTP_CLIENTS.get(loop), new_client)
        self.assertFalse(new_client.is_closed)

        with (
            patch.object(deps, "_get_auth_http_client", side_effect=[old_client, new_client]),
            patch("app.api.deps.asyncio.sleep", AsyncMock()),
            patch.object(deps, "_evict_auth_http_client", wraps=deps._evict_auth_http_client) as evict_spy,
        ):
            result = await get_current_parent_id(CREDENTIALS)

        self.assertEqual(result, ACTOR_ID)
        evict_spy.assert_awaited_once_with(old_client)
        self.assertIs(deps._AUTH_HTTP_CLIENTS.get(loop), new_client)
        self.assertFalse(new_client.is_closed)

        await deps._evict_auth_http_client(new_client)
        self.assertNotIn(loop, deps._AUTH_HTTP_CLIENTS)
        self.assertTrue(new_client.is_closed)


if __name__ == "__main__":
    unittest.main()
