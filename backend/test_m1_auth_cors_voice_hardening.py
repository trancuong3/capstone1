"""Milestone M1 regression tests for F1 (async auth), F2 (CORS preview regex), and F3 (Render voice guard)."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import Request

from app.api import deps
from app.api.routes import book as book_routes
from app.api.routes import voice as voice_routes
from app.database.config import (
    is_allowed_cors_origin,
    validate_cors_origin_regex,
)
from app.services import local_voice_worker_bootstrap as bootstrap

BACKEND_DIR = Path(__file__).resolve().parent
PREVIEW_REGEX = r"^https://viread-frontend(-[a-z0-9-]+)?\.vercel\.app$"


class M1CorsPreviewRegexTests(unittest.TestCase):
    def test_validate_cors_origin_regex_rejects_unsafe_patterns_and_accepts_preview_regex(self) -> None:
        self.assertIsNone(validate_cors_origin_regex(None))
        self.assertIsNone(validate_cors_origin_regex(""))
        self.assertIsNone(validate_cors_origin_regex("   "))

        for bad_pattern in (
            "*",
            ".*",
            ".+",
            "^.*$",
            "https://.*",
            "https?://.*",
            r"^https://.*\.vercel\.app$",
            r"^http://viread-frontend\.vercel\.app$",
            "[unclosed",
        ):
            with self.subTest(pattern=bad_pattern):
                with self.assertRaises(ValueError):
                    validate_cors_origin_regex(bad_pattern)

        compiled = validate_cors_origin_regex(PREVIEW_REGEX)
        self.assertIsNotNone(compiled)

    def test_is_allowed_cors_origin_matches_fullmatch_only(self) -> None:
        self.assertTrue(
            is_allowed_cors_origin(
                "https://viread-frontend.vercel.app",
                allowed_origins=(),
                origin_regex=PREVIEW_REGEX,
            )
        )
        self.assertTrue(
            is_allowed_cors_origin(
                "https://viread-frontend-git-feat-vercel-smoothness-team.vercel.app",
                allowed_origins=(),
                origin_regex=PREVIEW_REGEX,
            )
        )
        for blocked in (
            "",
            None,
            "https://evil.vercel.app",
            "https://viread-frontend.vercel.app.evil.com",
            "https://evil.example.com",
            "null",
        ):
            with self.subTest(origin=blocked):
                self.assertFalse(
                    is_allowed_cors_origin(
                        blocked,
                        allowed_origins=("http://localhost:3000",),
                        origin_regex=PREVIEW_REGEX,
                    )
                )

    def test_sever_unhandled_500_and_ws_origin_check_honor_preview_regex(self) -> None:
        import app.sever as sever_mod

        preview_origin = "https://viread-frontend-git-feat-test.vercel.app"
        blocked_origin = "https://viread-frontend.vercel.app.evil.com"

        req_ok = MagicMock(spec=Request)
        req_ok.headers = {"origin": preview_origin}
        req_ok.method = "GET"
        req_ok.url = SimpleNamespace(path="/books")
        req_ok.scope = {}
        req_ok.state = SimpleNamespace(request_id="req-preview-500")

        req_bad = MagicMock(spec=Request)
        req_bad.headers = {"origin": blocked_origin}
        req_bad.method = "GET"
        req_bad.url = SimpleNamespace(path="/books")
        req_bad.scope = {}
        req_bad.state = SimpleNamespace(request_id="req-blocked-500")

        with (
            patch.object(sever_mod, "CORS_ALLOWED_ORIGINS", ("http://localhost:3000",)),
            patch.object(sever_mod, "CORS_ALLOWED_ORIGIN_REGEX", PREVIEW_REGEX),
        ):
            res_ok = asyncio.run(sever_mod.unhandled_exception_handler(req_ok, RuntimeError("boom")))
            res_bad = asyncio.run(sever_mod.unhandled_exception_handler(req_bad, RuntimeError("boom")))

        self.assertEqual(res_ok.status_code, 500)
        self.assertEqual(res_ok.headers.get("access-control-allow-origin"), preview_origin)
        self.assertEqual(res_ok.headers.get("vary"), "Origin")
        self.assertIsNone(res_bad.headers.get("access-control-allow-origin"))

        ws_ok = SimpleNamespace(headers={"origin": preview_origin})
        ws_bad = SimpleNamespace(headers={"origin": blocked_origin})
        with (
            patch.object(voice_routes, "CORS_ALLOWED_ORIGINS", ("http://localhost:3000",)),
            patch.object(voice_routes, "CORS_ALLOWED_ORIGIN_REGEX", PREVIEW_REGEX),
        ):
            self.assertTrue(voice_routes._is_ws_origin_allowed(ws_ok))  # type: ignore[arg-type]
            self.assertFalse(voice_routes._is_ws_origin_allowed(ws_bad))  # type: ignore[arg-type]

    def test_real_sever_app_with_cors_regex_env_allows_preview_across_options_200_401_and_500(self) -> None:
        script = """
import json, os, sys
sys.path.insert(0, %r)
os.environ["APP_ENVIRONMENT"] = "test"
os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_KEY"] = "isolated-test-key"
os.environ["CORS_ALLOWED_ORIGINS"] = "https://viread.example.com"
os.environ["CORS_ALLOWED_ORIGIN_REGEX"] = %r

from fastapi.testclient import TestClient
import app.sever as sever_mod

@sever_mod.app.get("/_test_m1_boom")
async def _boom():
    raise RuntimeError("boom")

preview = "https://viread-frontend-git-pr-42.vercel.app"
evil = "https://evil.vercel.app"
client = TestClient(sever_mod.app, raise_server_exceptions=False)

opt_ok = client.options(
    "/books",
    headers={
        "Origin": preview,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization",
    },
)
opt_bad = client.options(
    "/books",
    headers={
        "Origin": evil,
        "Access-Control-Request-Method": "GET",
    },
)
ok_200 = client.get("/openapi.json", headers={"Origin": preview})
err_401 = client.get("/profiles/me", headers={"Origin": preview})
err_500 = client.get("/_test_m1_boom", headers={"Origin": preview})
err_500_bad = client.get("/_test_m1_boom", headers={"Origin": evil})

print(json.dumps({
    "opt_ok_status": opt_ok.status_code,
    "opt_ok_acao": opt_ok.headers.get("access-control-allow-origin"),
    "opt_bad_acao": opt_bad.headers.get("access-control-allow-origin"),
    "ok_200_status": ok_200.status_code,
    "ok_200_acao": ok_200.headers.get("access-control-allow-origin"),
    "err_401_status": err_401.status_code,
    "err_401_acao": err_401.headers.get("access-control-allow-origin"),
    "err_500_status": err_500.status_code,
    "err_500_acao": err_500.headers.get("access-control-allow-origin"),
    "err_500_vary": err_500.headers.get("vary"),
    "err_500_bad_acao": err_500_bad.headers.get("access-control-allow-origin"),
}))
""" % (str(BACKEND_DIR), PREVIEW_REGEX)

        proc = subprocess.run(
            [sys.executable, "-B", "-c", script],
            capture_output=True,
            text=True,
            check=True,
            timeout=120,
        )
        data = json.loads(proc.stdout.strip().splitlines()[-1])
        preview = "https://viread-frontend-git-pr-42.vercel.app"
        self.assertEqual(data["opt_ok_status"], 200)
        self.assertEqual(data["opt_ok_acao"], preview)
        self.assertIsNone(data["opt_bad_acao"])
        self.assertEqual(data["ok_200_status"], 200)
        self.assertEqual(data["ok_200_acao"], preview)
        self.assertEqual(data["err_401_status"], 401)
        self.assertEqual(data["err_401_acao"], preview)
        self.assertEqual(data["err_500_status"], 500)
        self.assertEqual(data["err_500_acao"], preview)
        self.assertEqual(data["err_500_vary"], "Origin")
        self.assertIsNone(data["err_500_bad_acao"])


class M1AuthAndLifespanIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_book_and_voice_auth_helpers_accept_both_async_and_sync_verifiers(self) -> None:
        actor_id = UUID("11111111-1111-4111-8111-111111111111")
        fake_db = MagicMock()
        fake_request = SimpleNamespace(
            headers={"authorization": "Bearer token-123"},
            app=SimpleNamespace(dependency_overrides={}),
        )

        # Async verifier on book._verify_optional_active_actor
        with (
            patch.object(book_routes, "get_current_parent_id", AsyncMock(return_value=actor_id)),
            patch.object(book_routes, "get_cached_profile_role", AsyncMock(return_value="parent")),
        ):
            self.assertEqual(
                await book_routes._verify_optional_active_actor(fake_request, fake_db),  # type: ignore[arg-type]
                actor_id,
            )

        # Sync mock verifier on book._verify_optional_active_actor
        with (
            patch.object(book_routes, "get_current_parent_id", return_value=actor_id),
            patch.object(book_routes, "get_cached_profile_role", AsyncMock(return_value="parent")),
        ):
            self.assertEqual(
                await book_routes._verify_optional_active_actor(fake_request, fake_db),  # type: ignore[arg-type]
                actor_id,
            )

        # Async & sync verifier on voice._verify_ws_parent_id
        fake_ws = SimpleNamespace(app=SimpleNamespace(dependency_overrides={}))
        with (
            patch.object(voice_routes, "get_current_parent_id", AsyncMock(return_value=actor_id)),
            patch.object(voice_routes, "_verify_ws_active_profile", AsyncMock(return_value=actor_id)),
        ):
            self.assertEqual(
                await voice_routes._verify_ws_parent_id(fake_ws, token="token-123"),  # type: ignore[arg-type]
                actor_id,
            )

        with (
            patch.object(voice_routes, "get_current_parent_id", return_value=actor_id),
            patch.object(voice_routes, "_verify_ws_active_profile", AsyncMock(return_value=actor_id)),
        ):
            self.assertEqual(
                await voice_routes._verify_ws_parent_id(fake_ws, token="token-123"),  # type: ignore[arg-type]
                actor_id,
            )

    async def test_lifespan_never_arms_local_voice_in_production_and_closes_auth_clients(self) -> None:
        import app.sever as sever_mod

        bootstrap.reset_local_voice_worker_bootstrap_state()
        self.addCleanup(bootstrap.reset_local_voice_worker_bootstrap_state)

        fake_engine = SimpleNamespace(dispose=AsyncMock())
        mock_bootstrap = AsyncMock(return_value=False)
        mock_aclose_auth = AsyncMock()

        with (
            patch.dict(
                os.environ,
                {
                    "APP_ENVIRONMENT": "production",
                    "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "false",
                    "VIREAD_OCR_MODE": "remote_worker",
                    "VIREAD_ENABLE_LIGHTWEIGHT_WORKERS": "false",
                    "VIREAD_ENABLE_SMART_STUDIO_WORKER": "false",
                },
                clear=False,
            ),
            patch.object(sever_mod, "APP_ENVIRONMENT", "production"),
            patch.object(sever_mod, "probe_database_connection", AsyncMock(return_value={"ok": False, "dns_resolved": True, "ssl_enabled": True, "pool_class": "NullPool", "pooler_mode": "transaction", "latency_ms": 1, "error_type": None})),
            patch.object(sever_mod, "ensure_local_voice_worker_running", mock_bootstrap),
            patch.object(sever_mod, "engine", fake_engine),
            patch.object(deps, "aclose_auth_http_clients", mock_aclose_auth),
        ):
            async with sever_mod.lifespan(sever_mod.app):
                self.assertFalse(bootstrap.is_local_voice_worker_autostart_armed())
                self.assertIsNone(sever_mod.app.state.background_workers["local_voice_bootstrap"])

        mock_bootstrap.assert_not_awaited()
        mock_aclose_auth.assert_awaited_once()
        fake_engine.dispose.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
